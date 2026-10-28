
const express = require("express");
const crypto = require("crypto");

const app = express();
app.disable("x-powered-by");

const PORT = process.env.PORT || 3000;
const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;
const APP_BASE_URL = process.env.APP_BASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const pendingStates = new Map();

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json"
  };
}

async function saveTokens(tokens) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error("Falta configurar Supabase en Render.");
  }

  const url =
    `${SUPABASE_URL}/rest/v1/tiktok_tokens?on_conflict=id`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      id: 1,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      open_id: tokens.openId || null,
      scope: tokens.scope || null,
      expires_at: new Date(tokens.expiresAt).toISOString(),
      refresh_expires_at: new Date(
        tokens.refreshExpiresAt
      ).toISOString(),
      updated_at: new Date().toISOString()
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Error guardando tokens en Supabase:", response.status, detail);
    throw new Error("No se pudieron guardar los tokens en Supabase.");
  }
}

app.get("/", (req, res) => {
  res.send(`
    <!doctype html>
    <html lang="es">
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Purffle Shorts</title>
      <h1>Purffle Shorts</h1>
      <p>Servidor de autorización de TikTok.</p>
      <p>La conexión se almacena en Supabase cuando se autoriza correctamente.</p>
      <a href="/auth/tiktok">Conectar con TikTok</a>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "purffle-tiktok-auth" });
});

app.get("/auth/tiktok", (req, res) => {
  if (
    !CLIENT_KEY ||
    !CLIENT_SECRET ||
    !REDIRECT_URI ||
    !APP_BASE_URL
  ) {
    return res.status(503).send(
      "Falta configurar una variable de entorno de TikTok en Render."
    );
  }

  const state = crypto.randomBytes(32).toString("hex");

  for (const [key, createdAt] of pendingStates.entries()) {
    if (Date.now() - createdAt > 10 * 60 * 1000) {
      pendingStates.delete(key);
    }
  }

  pendingStates.set(state, Date.now());

  const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.search = new URLSearchParams({
    client_key: CLIENT_KEY,
    response_type: "code",
    scope: "user.info.basic,video.publish,video.upload",
    redirect_uri: REDIRECT_URI,
    state
  }).toString();

  res.redirect(url.toString());
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(
      `TikTok no autorizó la conexión: ${String(
        error_description || error
      )}`
    );
  }

  if (
    typeof state !== "string" ||
    !pendingStates.has(state) ||
    Date.now() - pendingStates.get(state) > 10 * 60 * 1000
  ) {
    return res.status(400).send(
      "Estado de autorización inválido o caducado. Vuelve a iniciar la conexión."
    );
  }

  pendingStates.delete(state);

  if (typeof code !== "string" || !code) {
    return res.status(400).send(
      "TikTok no devolvió un código de autorización."
    );
  }

  try {
    const body = new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI
    });

    const response = await fetch(
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Cache-Control": "no-cache"
        },
        body
      }
    );

    const result = await response.json();

    if (!response.ok || result.error) {
      console.error("Error de autorización de TikTok:", {
        status: response.status,
        error: result.error,
        description: result.error_description
      });

      return res.status(400).send(
        "TikTok no pudo completar la autorización. Revisa la configuración y vuelve a intentarlo."
      );
    }

    if (!result.access_token || !result.refresh_token) {
      return res.status(400).send(
        "TikTok no devolvió todos los datos de autorización necesarios."
      );
    }

    const tokens = {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt:
        Date.now() + Number(result.expires_in || 0) * 1000,
      refreshExpiresAt:
        Date.now() +
        Number(result.refresh_expires_in || 0) * 1000,
      openId: result.open_id,
      scope: result.scope
    };

    await saveTokens(tokens);

    return res.status(200).send(`
      <!doctype html>
      <html lang="es">
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Purffle Shorts</title>
        <h1>Autorización recibida</h1>
        <p>TikTok devolvió los tokens y Supabase confirmó su almacenamiento.</p>
        <p>La renovación automática y la publicación de vídeos todavía deben configurarse y probarse.</p>
        <a href="/">Volver a Purffle Shorts</a>
      </html>
    `);
  } catch (err) {
    console.error("Fallo al conectar o guardar tokens:", err.message);

    return res.status(500).send(
      "No se pudo completar la conexión o guardar los tokens. Revisa los registros de Render."
    );
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor iniciado en el puerto ${PORT}`);
});
