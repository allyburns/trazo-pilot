#!/usr/bin/env node
// An MCP server (stdio) that lets an AI fly Trazo. It hosts a WebSocket on
// port 8787; the game page connects to it when served from localhost, and
// each tool call becomes one message to the page. stdout belongs to MCP, so
// logging goes to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { z } from 'zod';

const PORT = 8787;
const REPLY_MS = 5000;
const MAX_FOLLOW_S = 120;

// Pages in the order they connected. Tools talk to the first, so a second
// tab opening mid-flight cannot swap in a different game; it takes over only
// when the first goes away.
const pages = [];
let nextId = 1;
const pending = new Map();

// Only the game served on this machine may connect: a page from anywhere
// else in the browser (or a script on one) could otherwise answer the tools
// and put its own words in front of the agent.
// The dev server's port is 6700 (6701 when 6700 is taken); no other local
// server, which might have bugs of its own, may connect.
const GAME_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):670[01]$/;
// And the game itself, on its own sites, which connect only in pilot mode
// opened with ?pilot=mcp and only once the player clicks Connect.
const LIVE_ORIGINS = ['https://playtrazo.com', 'https://trazo.allyburns.workers.dev', 'https://trazo-staging.allyburns.workers.dev'];
const fromGame = (origin) => GAME_ORIGIN.test(origin ?? '') || LIVE_ORIGINS.includes(origin);
const wss = new WebSocketServer({
  port: PORT,
  host: '127.0.0.1',
  maxPayload: 1 << 20, // a state or telemetry reply is a few kilobytes
  verifyClient: ({ origin }) => fromGame(origin),
});
wss.on('listening', () => console.error(`trazo: waiting for the game on ws://localhost:${PORT}`));
wss.on('error', (err) => console.error(`trazo: WebSocket ${err.message}`));
wss.on('connection', (ws) => {
  pages.push(ws);
  console.error(`trazo: game connected (${pages.length} open, using the first)`);
  ws.on('message', (data) => {
    let reply;
    try { reply = JSON.parse(data); } catch { return; } // not ours
    const { id, result, error } = reply ?? {};
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    error ? p.reject(new Error(error)) : p.resolve(result);
  });
  ws.on('close', () => {
    pages.splice(pages.indexOf(ws), 1);
    console.error(`trazo: game disconnected (${pages.length} open)`);
  });
});

function send(cmd, args = {}) {
  const page = pages[0];
  if (!page) return Promise.reject(new Error('No game connected. Open https://playtrazo.com/?pilot=mcp in Chrome or Firefox, click Connect to my MCP server, and keep the tab visible (on the dev server: http://localhost:6700/?pilot).'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    page.send(JSON.stringify({ id, cmd, ...args }));
    setTimeout(() => pending.delete(id) && reject(new Error(`the game did not answer ${cmd}`)), REPLY_MS);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const tool = (fn) => async (args) => {
  try {
    return json(await fn(args));
  } catch (err) {
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
};

const server = new McpServer({ name: 'trazo', version: '0.2.1' }, {
  instructions: 'Fly Trazo, a browser game: paint a Nazca line from the air. Use the pilot_ tools: the game stands still between pilot_step calls, and each flies 1 to 40 slices of 0.25 s with the targets you set. Read pilot_help first. When the run ends, post it with pilot_post and your model\'s own name. follow_line is the built-in autopilot and is refused in pilot mode.',
});

// Pilot mode (src/pilot.js): the turn-based game an AI agent flies, one
// window.trazoPilot call per tool.
const pilot = (op, args) => send('pilot', { op, args });
const STEP = {
  heading: z.number().optional().describe('target heading, deg clockwise from north'),
  left: z.number().min(0).max(360).optional().describe('turn the heading target this many degrees left of the nose'),
  right: z.number().min(0).max(360).optional().describe('turn the heading target this many degrees right of the nose'),
  altitude: z.number().optional().describe('target altitude in m; below 1 m the plane crashes; poles are 33 m tall'),
  speed: z.number().optional().describe('target speed, 12 to 38 m/s (cruise 20)'),
  circle: z.boolean().optional().describe('hold the big circle (true) to hook a pole whose sun says can hook; false lets go of the rope'),
  reel: z.enum(['in', 'out', 'hold']).optional().describe('on a taut rope: steer into the pole, away from it, or neither'),
  steps: z.number().int().min(1).max(40).optional().describe('slices of 0.25 s to fly (1 if left out); stops early when something changes on screen'),
};
server.registerTool('pilot_help', { description: 'The rules of pilot mode and what every command does. Read this first.' }, tool(() => pilot('help')));
server.registerTool('pilot_state', { description: 'Everything a player could see on screen, as numbers: the plane, the painting, the line ahead as (right, ahead) metres from the nose, poles and their reach, the rope and its release window, the speed-up arrows, dust devils and condors, and why the last step stopped.' }, tool(() => pilot('state')));
server.registerTool('pilot_step', { description: 'Set targets (any of them) and fly some slices. Returns the state afterwards. Targets stay set until changed.', inputSchema: STEP }, tool((args) => pilot('step', args)));
server.registerTool('pilot_pause', { description: 'Pause: steps are refused until pilot_resume.' }, tool(() => pilot('pause')));
server.registerTool('pilot_resume', { description: 'Carry on after pilot_pause.' }, tool(() => pilot('resume')));
server.registerTool('pilot_restart', { description: 'End this run and start the stretch again.' }, tool(() => pilot('restart')));
server.registerTool('pilot_post', {
  description: 'Post the run to the AI board at playtrazo.com/ai, finished or not, under your model\'s own name for itself. Posting ends the run. Runs are ranked by game time; each one\'s commands are posted with it and flown again to check it.',
  inputSchema: {
    model: z.string().describe('your model name, lower case, no spaces, such as claude-opus-5-5'),
    agent: z.string().optional().describe('what is driving you, the same characters, such as claude-code'),
    operator: z.string().optional().describe('the nickname of the person running you, if they want it shown'),
  },
}, tool((args) => pilot('post', args)));

server.registerTool('get_state', {
  description: 'The plane and its progress on the line: x, z (m, east and south of the Hummingbird), altitude (m), heading (deg clockwise from north), bank, pitch, throttle (0..1), speed (m/s), boostHeat (0..2: past 1 the afterburner burns while boost is held, at 2 it overheats), afterburning, overheat (s of boost lockout left), crashed, onLine, distanceOffLine (m), t (m along the line nearest the plane), filled (m coloured), length (m), streak, score, done.',
}, tool(() => send('state')));

server.registerTool('set_targets', {
  description: 'Set targets the in-game autopilot flies toward: it banks to reach the heading, pitches to reach the altitude, and boosts or air-brakes to hold the speed the throttle asks for (cruising is 20 m/s). Omit a field to leave it alone, or pass null to let go of it.',
  inputSchema: {
    heading: z.number().nullable().optional().describe('deg clockwise from north'),
    altitude: z.number().nullable().optional().describe('m; below 1 m the plane crashes'),
    throttle: z.number().min(0).max(1).nullable().optional().describe('target speed: 0 is 12 m/s, 1 is 38 m/s; held with boost and air brake'),
  },
}, tool((args) => send('set', args)));

server.registerTool('follow_line', {
  description: 'Engage the line-following autopilot for this many seconds: it steers at the point on the figure 25 m past the end of the painting, boosts down the straights and brakes for corners. Returns the state when the time is up.',
  inputSchema: { seconds: z.number().positive().max(MAX_FOLLOW_S) },
}, tool(async ({ seconds }) => {
  await send('follow', { seconds });
  await sleep(seconds * 1000);
  return send('state');
}));

server.registerTool('restart', {
  description: 'Start the run again, short of the first point and heading along the line. Clears the autopilot.',
}, tool(() => send('restart')));

server.registerTool('get_telemetry', {
  description: 'Every run logged in this browser, newest last, with a summary (runs, completed, voluntary restarts, by the autopilot). Each run: date, figure, pilot (player, or autopilot if the autopilot flew any of it), how it ended (completed, restart, left), duration (s), painted and length (m), score, best streak (s), breaks, breakPositions (m along the line where each streak broke), crashes. A restart, from R or the restart tool, ends a run as a voluntary restart.',
}, tool(() => send('telemetry')));

await server.connect(new StdioServerTransport());
// When the MCP host goes away, free the port rather than linger as an orphan.
process.stdin.on('close', () => process.exit(0));
