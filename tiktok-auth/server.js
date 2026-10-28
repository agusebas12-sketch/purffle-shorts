
const express = require("express");
const crypto = require("crypto");

const app = express();
app.disable("x-powered-by");

const PORT = process.env.PORT || 3000;
const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;
const APP_BASE_URL = process.env.APP_BASE_URL;

const pendingStates = new Map();

app.get("/", (req, res) => {
  res.send(`
    <!doctype html>
    <html lang="es">
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Purffle Shorts</title>
      <h1>Purffle Shorts</h1>
      <p>Servidor de autorización de TikTok.</p>
      <p>Este servidor todavía no publica vídeos.</p>
      <a href="/auth/tiktok">Conectar con TikTok</a>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "purffle-tiktok-auth" });
});

app.get("/auth/tiktok", (req, res) => {
  if (!CLIENT_KEY || !REDIRECT_URI || !APP_BASE_URL) {
    return res.status(503).send(
      "Falta configurar las variables de entorno de TikTok en Render."
    );
  }

  const state = crypto.randomBytes(32).toString("hex");
  pendingStates.set(state, Date.now());

  // El estado expira después de 10 minutos.
  for (const [key, createdAt] of pendingStates.entries()) {
    if (Date.now() - createdAt > 10 * 60 * 1000) {
      pendingStates.delete(key);
    }
  }

  const authorizationUrl = new URL(
    "https://www.tiktok.com/v2/auth/authorize/"
  );

  authorizationUrl.search = new URLSearchParams({
    client_key: CLIENT_KEY,
    response_type: "code",
    scope: "user.info.basic,video.publish,video.upload",
    redirect_uri: REDIRECT_URI,
    state
  }).toString();

  res.redirect(authorizationUrl.toString());
});

app.get("/auth/callback", (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(
      "TikTok no autorizó la conexión. Puedes volver a intentarlo."
    );
  }

  if (
    typeof state !== "string" ||
    !pendingStates.has(state) ||
    Date.now() - pendingStates.get(state) > 10 * 60 * 1000
  ) {
    return res.status(400).send(
      "Estado de autorización inválido o caducado. Inicia la conexión otra vez."
    );
  }

  pendingStates.delete(state);

  if (typeof code !== "string" || !code) {
    return res.status(400).send(
      "TikTok no devolvió un código de autorización."
    );
  }

  // No mostramos ni guardamos el código ni los tokens en la página.
  // El intercambio seguro del código por tokens se añadirá después.
  res.status(200).send(`
    <!doctype html>
    <html lang="es">
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Autorización recibida</title>
      <h1>Respuesta recibida</h1>
      <p>El servidor recibió la respuesta de TikTok.</p>
      <p>La conexión todavía no está completada y no se ha publicado ningún vídeo.</p>
    </html>
  `);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor iniciado en el puerto ${PORT}`);
});
