
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
let refreshInProgress = null;

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

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/tiktok_tokens?on_conflict=id`,
    {
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
    }
  );

  if (!response.ok) {
    console.error(
      "Error guardando tokens en Supabase:",
      response.status,
      await response.text()
    );
    throw new Error("No se pudieron guardar los tokens.");
  }
}

async function loadTokens() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error("Falta configurar Supabase en Render.");
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/tiktok_tokens?select=id,access_token,refresh_token,open_id,scope,expires_at,refresh_expires_at&id=eq.1`,
    { headers: supabaseHeaders() }
  );

  if (!response.ok) {
    throw new Error(
      `Error leyendo tokens de Supabase: HTTP ${response.status}`
    );
  }

  const rows = await response.json();
  return rows[0] || null;
}

async function refreshTokensIfNeeded() {
  if (refreshInProgress) return refreshInProgress;

  refreshInProgress = (async () => {
    const stored = await loadTokens();

    if (!stored) {
      console.log("Todavía no hay tokens de TikTok guardados.");
      return;
    }

    const expiresAt = Date.parse(stored.expires_at);

    // Renovar cuando falten 10 minutos o menos.
    if (
      Number.isFinite(expiresAt) &&
      expiresAt - Date.now() > 10 * 60 * 1000
    ) {
      return;
    }

    const refreshExpiresAt = Date.parse(
      stored.refresh_expires_at
    );

    if (
      Number.isFinite(refreshExpiresAt) &&
      refreshExpiresAt <= Date.now()
    ) {
      console.error(
        "El refresh token ha caducado. Hace falta volver a autorizar TikTok."
      );
      return;
    }

    if (!stored.refresh_token) {
      throw new Error("No existe refresh token guardado.");
    }

    const body = new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token
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

    if (
      !response.ok ||
      result.error ||
      !result.access_token ||
      !result.refresh_token
    ) {
      console.error("TikTok rechazó la renovación:", {
        status: response.status,
        error: result.error,
        description: result.error_description
      });
      throw new Error("No se pudieron renovar los tokens.");
    }

    const now = Date.now();

    await saveTokens({
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      openId: result.open_id || stored.open_id,
      scope: result.scope || stored.scope,
      expiresAt: now + Number(result.expires_in) * 1000,
      refreshExpiresAt: result.refresh_expires_in
        ? now + Number(result.refresh_expires_in) * 1000
        : refreshExpiresAt
    });

    console.log("Tokens renovados y guardados en Supabase.");
  })();

  try {
    await refreshInProgress;
  } finally {
    refreshInProgress = null;
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
      <p>La conexión se almacena en Supabase.</p>
      <a href="/auth/tiktok">Conectar con TikTok</a>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "purffle-tiktok-auth"
  });
});

app.get("/auth/tiktok", (req, res) => {
  if (
    !CLIENT_KEY ||
    !CLIENT_SECRET ||
    !REDIRECT_URI ||
    !APP_BASE_URL
  ) {
    return res.status(503).send(
      "Falta configurar una variable de entorno en Render."
    );
  }

  const state = crypto.randomBytes(32).toString("hex");

  for (const [key, createdAt] of pendingStates.entries()) {
    if (Date.now() - createdAt > 10 * 60 * 1000) {
      pendingStates.delete(key);
    }
  }

  pendingStates.set(state, Date.now());

  const url = new URL(
    "https://www.tiktok.com/v2/auth/authorize/"
  );

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
      "Estado inválido o caducado. Vuelve a conectar TikTok."
    );
  }

  pendingStates.delete(state);

  if (typeof code !== "string" || !code) {
    return res.status(400).send(
      "TikTok no devolvió el código de autorización."
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

    if (
      !response.ok ||
      result.error ||
      !result.access_token ||
      !result.refresh_token
    ) {
      console.error("Error de autorización:", {
        status: response.status,
        error: result.error,
        description: result.error_description
      });

      return res.status(400).send(
        "TikTok no pudo completar la autorización. Revisa los registros de Render."
      );
    }

    const now = Date.now();

    await saveTokens({
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: now + Number(result.expires_in) * 1000,
      refreshExpiresAt:
        now + Number(result.refresh_expires_in) * 1000,
      openId: result.open_id,
      scope: result.scope
    });

    return res.status(200).send(`
      <!doctype html>
      <html lang="es">
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Purffle Shorts</title>
        <h1>Autorización recibida</h1>
        <p>TikTok devolvió los tokens y Supabase confirmó su almacenamiento.</p>
        <p>El servidor comprobará periódicamente si debe renovarlos. La renovación debe verificarse en los registros de Render.</p>
        <p>La publicación automática de vídeos todavía no está configurada.</p>
        <a href="/">Volver a Purffle Shorts</a>
      </html>
    `);
  } catch (err) {
    console.error("Fallo en la autorización:", err.message);

    return res.status(500).send(
      "No se pudo completar la conexión. Revisa los registros de Render."
    );
  }
});

async function tokenMaintenance() {
  try {
    await refreshTokensIfNeeded();
  } catch (err) {
    console.error("Mantenimiento de tokens:", err.message);
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor iniciado en el puerto ${PORT}`);

  // Comprobar al arrancar y después cada cinco minutos.
  tokenMaintenance();
  setInterval(tokenMaintenance, 5 * 60 * 1000);
});
