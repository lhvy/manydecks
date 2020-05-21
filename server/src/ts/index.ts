import expressWinston from "express-winston";
import bodyParser from "body-parser";
import helmet from "helmet";
import sourceMapSupport from "source-map-support";
import * as Logging from "./logging";
import express, { NextFunction, Request, Response } from "express";
import "express-async-errors";
import HttpStatus from "http-status-codes";
import * as Code from "./deck/code";
import Json5 from "json5";
import { promises as fs } from "fs";
import * as Store from "./store";
import * as Errors from "./errors";
import * as Auth from "./user/auth";
import { default as GoogleAuth } from "google-auth-library";
import * as Uuid from "uuid";
// @ts-ignore
import { default as Zip } from "express-easy-zip";

sourceMapSupport.install();

process.on("uncaughtException", function (error) {
  Logging.logException("Uncaught exception: ", error);
});

process.on("unhandledRejection", function (reason, promise) {
  if (reason instanceof Error) {
    Logging.logException(`Unhandled rejection for ${promise}.`, reason);
  } else {
    Logging.logger.error(`Unhandled rejection at ${promise}: ${reason}`);
  }
});

const main = async (): Promise<void> => {
  const config = Json5.parse((await fs.readFile("config.json5")).toString());

  const store = await Store.init(config.connection);
  const auth = new Auth.Auth(config.auth.local);

  const google = new GoogleAuth.OAuth2Client(config.auth.google.id);

  const app = express();

  app.use(helmet());
  app.set("trust proxy", true);
  app.use(bodyParser.json());
  app.use(Zip());

  app.use(
    expressWinston.logger({
      winstonInstance: Logging.logger,
    })
  );

  app.post("/api/users", async (req, res) => {
    if (req.body.token !== undefined) {
      const claims = auth.validate(req.body.token);
      const id = claims.sub;
      const name = req.body.name;
      await store.changeUser(id, name);
      res.json({ token: auth.sign({ sub: id }), name });
      return;
    } else {
      const ticket = await google.verifyIdToken({
        idToken: req.body.google,
        audience: config.auth.google.id,
      });
      const payload = ticket.getPayload();
      if (payload !== undefined) {
        const { id, name } = await store.findOrCreateUser(
          payload.sub,
          payload.name
        );
        res.json({ token: auth.sign({ sub: id }), name });
        return;
      }
    }
    res.status(HttpStatus.UNAUTHORIZED).json({ error: "NotAuthenticated" });
  });

  app.delete("/api/users", async (req, res) => {
    const claims = auth.validate(req.body.token);
    await store.deleteUser(claims.sub);
    res.status(HttpStatus.OK);
  });

  app.get("/api/decks/:deckCode", async (req, res) => {
    const id = Code.decode(req.params.deckCode);
    const result = await store.getDeck(id);
    res.json(result);
  });

  app.get("/api/decks/:deckCode/summary", async (req, res) => {
    const id = Code.decode(req.params.deckCode);
    const result = await store.getSummary(id);
    res.json(result);
  });

  app.patch("/api/decks/:deckCode", async (req, res) => {
    const id = Code.decode(req.params.deckCode);
    const claims = auth.validate(req.body.token);
    const result = await store.updateDeck(id, claims.sub, req.body.patch);
    res.json(result);
  });

  app.post("/api/decks", async (req, res) => {
    const claims = auth.validate(req.body.token);
    const initial = req.body.initial;
    if (initial !== undefined) {
      const id = await store.create(initial, claims.sub);
      const code = Code.encode(id);
      res.status(HttpStatus.CREATED).json(code);
    } else {
      const decks = await store.getSummariesForUser(claims.sub);
      res.json(decks);
    }
  });

  app.post("/api/backup", async (req, res) => {
    const claims = auth.validate(req.body.token);
    const files = await store.getDecks(claims.sub);
    // @ts-ignore
    res.zip({
      files: files.map((c) => {
        delete c.version;
        return {
          content: Json5.stringify(c, undefined, 2),
          name: `${c.name.replace(/\s/g, "-")}-${
            c.language
          }-${Uuid.v4()}.deck.json5`,
        };
      }),
      filename: "backup.zip",
    });
  });

  app.delete("/api/decks/:deckCode", async (req, res) => {
    const id = Code.decode(req.params.deckCode);
    const claims = auth.validate(req.body.token);
    await store.deleteDeck(id, claims.sub);
    res.status(HttpStatus.OK);
  });

  app.use(
    expressWinston.errorLogger({
      winstonInstance: Logging.logger,
      msg: "{{err.message}}",
    })
  );

  app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
    }
    if (error instanceof Errors.ManyDecksError) {
      res.status(error.status).json(error.error());
    } else {
      res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: "InternalServerError" });
    }
  });

  app.listen(config.listenOn, async () => {
    Logging.logger.info(`Listening on ${config.listenOn}.`);
  });
};

main().catch((error) => {
  Logging.logException("Application exception:", error);
  process.exit(1);
});
