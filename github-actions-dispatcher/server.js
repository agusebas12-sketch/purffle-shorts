"use strict";

const express = require("express");
const crypto = require("node:crypto");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "8kb", strict: true }));

const PORT = Number(process.env.PORT || 10000);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const DISPATCH_API_KEY = process.env.DISPATCH_API_KEY || "";
const OWNER = "agusebas12-sketch";
const REPO = "purffle-shorts";
const API_VERSION = "2022-11-28";

// Deliberately excludes both Instagram (triggered automatically) and TikTok.
const ALLOWED_WORKFLOWS = new Set([
  "daily-short.yml",
  "daily-long-video.yml"
]);

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireConfigured(req, res, next) {
  if (!GITHUB_TOKEN || !DISPATCH_API_KEY) {
    return res.status(503).json({ error: "Dispatcher is not configured." });
  }
  next();
}

function requireApiKey(req, res, next) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !constantTimeEqual(match[1], DISPATCH_API_KEY)) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  next();
}

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    configured: Boolean(GITHUB_TOKEN && DISPATCH_API_KEY)
  });
});

app.post("/actions/dispatch", requireConfigured, requireApiKey, async (req, res) => {
  const workflow = req.body && req.body.workflow;

  if (typeof workflow !== "string" || !ALLOWED_WORKFLOWS.has(workflow)) {
    return res.status(400).json({
      error: "Workflow not allowed.",
      allowed_workflows: Array.from(ALLOWED_WORKFLOWS)
    });
  }

  const endpoint = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": API_VERSION,
        "Content-Type": "application/json",
        "User-Agent": "Purffle-Shorts-Dispatcher"
      },
      body: JSON.stringify({ ref: "main" }),
      signal: AbortSignal.timeout(15000)
    });

    if (response.status !== 204) {
      // Do not return GitHub's response body: it may contain implementation details.
      return res.status(502).json({
        error: "GitHub rejected the workflow dispatch.",
        github_status: response.status
      });
    }

    return res.status(202).json({
      accepted: true,
      repository: `${OWNER}/${REPO}`,
      workflow,
      ref: "main",
      message: "GitHub accepted the dispatch. Check Actions for the run result."
    });
  } catch (error) {
    console.error("GitHub dispatch request failed:", error.name || "Error");
    return res.status(502).json({ error: "Could not contact GitHub." });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON body." });
  }
  console.error("Unhandled dispatcher error:", err.name || "Error");
  return res.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Purffle GitHub dispatcher listening on port ${PORT}`);
});
