/**
 * Dump the seeded landmark as ASCII so its legibility can be checked without
 * opening a browser. Pixel art at 1:1 is unreadable in a terminal, so this
 * prints one character per pixel row-major, downsampled 2x horizontally to
 * compensate for character aspect ratio.
 */
import pg from "pg";

const X0 = 524160, Y0 = 524224, W = 256, H = 128;
const client = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://canvasplanet:canvasplanet_dev@127.0.0.1:5544/canvasplanet",
});
await client.connect();

const { rows } = await client.query(
  `SELECT x, y, color FROM pixels
    WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4`,
  [X0, X0 + W - 1, Y0, Y0 + H - 1],
);
console.log(`${rows.length} pixels in the landmark area`);

const grid = Array.from({ length: H }, () => new Int16Array(W).fill(-1));
for (const r of rows) grid[r.y - Y0][r.x - X0] = r.color;

// 4 = white border, 28 = navy fill, 13 = yellow title, 31 = shallow url
const CH = { "-1": " ", 4: "#", 28: ".", 13: "@", 31: "o" };

for (let y = 0; y < H; y += 2) {
  let line = "";
  for (let x = 0; x < W; x += 2) line += CH[grid[y][x]] ?? "?";
  console.log(line);
}

const counts = {};
for (const r of rows) counts[r.color] = (counts[r.color] ?? 0) + 1;
console.log("\ncolour histogram:", counts);
await client.end();
