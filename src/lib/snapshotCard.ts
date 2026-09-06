import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { BestScore } from "./tarmacDefenseBest";
import { formatTokenCount } from "./formatTokens";
import type { TokenStats } from "./tokenStats";

/** X-optimal 16:9 at a size that stays crisp on both retina and standard displays. */
export const SNAPSHOT_WIDTH = 1200;
export const SNAPSHOT_HEIGHT = 675;

export interface SnapshotData {
  tokens: TokenStats;
  sessionsToday: number;
  projects: number;
  best: BestScore | null;
  version: string | null;
  now: Date;
}

/**
 * Card palette, hand-tuned to the app's OKLCH design tokens (src/index.css)
 * but expressed as plain hex/rgba — canvas fillStyle support for oklch()
 * strings isn't reliable enough across webviews yet to risk on brand's
 * most public pixels. Keep these in sync with index.css by eye if the
 * theme changes.
 */
const PALETTE = {
  bg: "#1a1c20",
  bgGradientTop: "#20232a",
  surface: "#24262c",
  border: "#34373f",
  ink: "#f1f0ef",
  inkMuted: "#a8aab0",
  inkFaint: "#75767d",
  accent: "#6f9dfa",
  accentDim: "rgba(111,157,250,0.16)",
  working: "#5fdb9e",
};

/** Formats the local date the way a boarding pass would: "MON 06 SEP 2026". */
function formatFlightDate(d: Date): string {
  const weekday = d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
  const day = String(d.getDate()).padStart(2, "0");
  const month = d.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
  return `${weekday} ${day} ${month} ${d.getFullYear()}`;
}

/**
 * Pure content model for the card — separated from drawing so the copy and
 * numbers are unit-testable without a canvas.
 */
export interface SnapshotContent {
  headline: string;
  headlineLabel: string;
  supportingLine: string;
  allTimeLine: string;
  bestLine: string | null;
  flightDate: string;
  tailNumber: string;
}

export function buildSnapshotContent(data: SnapshotData): SnapshotContent {
  const { tokens } = data;
  const allTime = tokens.totalInput + tokens.totalOutput;
  return {
    headline: formatTokenCount(tokens.todayOutput),
    headlineLabel: "TOKENS OUT TODAY",
    supportingLine: `${formatTokenCount(tokens.todayInput)} in · ${formatTokenCount(tokens.todayCacheRead)} cache read`,
    allTimeLine: `${formatTokenCount(allTime)} all-time · ${data.sessionsToday} session${data.sessionsToday === 1 ? "" : "s"} today · ${data.projects} project${data.projects === 1 ? "" : "s"}`,
    bestLine:
      data.best && data.best.score > 0
        ? `Tarmac Defense best: ${data.best.score} pts · Level ${data.best.level}`
        : null,
    flightDate: formatFlightDate(data.now),
    tailNumber: `AT-${String(tokens.sessionCount).padStart(3, "0")}`,
  };
}

/** The delta-wing mark, matching JetIcon.tsx's geometry, scaled up for the card. */
function drawJet(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number, color: string) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.fillStyle = color;
  ctx.beginPath();
  // Same path as JetIcon's JET_PATH, centered on its own bounding box.
  ctx.moveTo(0, -6.8);
  ctx.lineTo(5.4, 4.2);
  ctx.lineTo(0, 1.8);
  ctx.lineTo(-5.4, 4.2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawRunwayCenterline(ctx: CanvasRenderingContext2D, y: number, width: number, marginX: number) {
  ctx.save();
  ctx.strokeStyle = PALETTE.border;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 10]);
  ctx.beginPath();
  ctx.moveTo(marginX, y);
  ctx.lineTo(width - marginX, y);
  ctx.stroke();
  ctx.restore();
}

/** Draws the full card onto a 2D context sized SNAPSHOT_WIDTH x SNAPSHOT_HEIGHT. */
export function drawSnapshotCard(ctx: CanvasRenderingContext2D, data: SnapshotData) {
  const W = SNAPSHOT_WIDTH;
  const H = SNAPSHOT_HEIGHT;
  const content = buildSnapshotContent(data);
  const marginX = 72;

  // Ground: a subtle top-to-bottom gradient rather than flat fill, so the
  // dark surface still reads as designed rather than a placeholder rect.
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, PALETTE.bgGradientTop);
  bgGrad.addColorStop(1, PALETTE.bg);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // Faint radar-sweep glow behind the headline, echoing OnApproachIllustration.
  const glow = ctx.createRadialGradient(W / 2, 210, 40, W / 2, 210, 420);
  glow.addColorStop(0, "rgba(111,157,250,0.14)");
  glow.addColorStop(1, "rgba(111,157,250,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Header row: wordmark + flight date, boarding-pass style.
  ctx.fillStyle = PALETTE.inkMuted;
  ctx.font = "600 20px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  drawJet(ctx, marginX + 10, 66, 1.6, PALETTE.accent);
  ctx.fillText("AGENT TARMAC", marginX + 30, 72);

  ctx.textAlign = "right";
  ctx.fillStyle = PALETTE.inkFaint;
  ctx.font = "500 15px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText(content.flightDate, W - marginX, 60);
  ctx.font = "500 13px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText(content.tailNumber, W - marginX, 78);
  ctx.textAlign = "left";

  drawRunwayCenterline(ctx, 108, W, marginX);

  // Eyebrow — the tokenmaxxing nod, small and quiet, not a section kicker.
  ctx.fillStyle = PALETTE.accent;
  ctx.font = "600 14px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText("TODAY'S TOKENMAXXING", marginX, 168);

  // Headline: the flex number.
  ctx.fillStyle = PALETTE.ink;
  ctx.font = "700 132px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText(content.headline, marginX, 300);

  ctx.fillStyle = PALETTE.inkMuted;
  ctx.font = "600 18px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText(content.headlineLabel, marginX + 4, 330);

  ctx.fillStyle = PALETTE.inkFaint;
  ctx.font = "400 20px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText(content.supportingLine, marginX, 372);

  drawRunwayCenterline(ctx, 420, W, marginX);

  // Manifest row: all-time totals, flight-log style.
  ctx.fillStyle = PALETTE.ink;
  ctx.font = "500 22px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillText(content.allTimeLine, marginX, 468);

  // Tarmac Defense best, as a boarding-pass "seat" style stub — only when
  // there's a real run to show.
  if (content.bestLine) {
    const stubY = 508;
    const stubH = 88;
    const stubW = W - marginX * 2;
    ctx.fillStyle = PALETTE.surface;
    ctx.strokeStyle = PALETTE.border;
    ctx.lineWidth = 1;
    roundRect(ctx, marginX, stubY, stubW, stubH, 14);
    ctx.fill();
    ctx.stroke();

    drawJet(ctx, marginX + 40, stubY + stubH / 2, 2, PALETTE.working);

    ctx.fillStyle = PALETTE.inkMuted;
    ctx.font = "600 14px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText("TARMAC DEFENSE", marginX + 76, stubY + 34);
    ctx.fillStyle = PALETTE.ink;
    ctx.font = "600 24px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(content.bestLine.replace("Tarmac Defense best: ", ""), marginX + 76, stubY + 64);
  }

  // Footer.
  ctx.fillStyle = PALETTE.inkFaint;
  ctx.font = "400 14px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("Agent Tarmac · agent-tarmac", marginX, H - 40);
  ctx.textAlign = "right";
  if (data.version) {
    ctx.fillText(`v${data.version}`, W - marginX, H - 40);
  }
  ctx.textAlign = "left";
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Renders the card to an offscreen canvas and resolves with a PNG blob. */
export function renderSnapshotBlob(data: SnapshotData): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = SNAPSHOT_WIDTH;
  canvas.height = SNAPSHOT_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("2D canvas context unavailable"));
  drawSnapshotCard(ctx, data);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Failed to encode snapshot PNG"));
    }, "image/png");
  });
}

export type ShareSnapshotResult = { method: "clipboard" } | { method: "file"; path: string } | { method: "cancelled" };

/**
 * Renders the card and copies it to the clipboard as a PNG. If the webview's
 * clipboard write is unavailable or rejected (some Tauri webviews restrict
 * `navigator.clipboard.write` for non-text types), falls back to a save
 * dialog + direct file write so the user still gets the image.
 */
export async function shareSnapshot(data: SnapshotData): Promise<ShareSnapshotResult> {
  const blob = await renderSnapshotBlob(data);

  try {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      throw new Error("Clipboard image write not supported in this webview");
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return { method: "clipboard" };
  } catch {
    const path = await save({
      title: "Save tokenmaxxing snapshot",
      defaultPath: `agent-tarmac-snapshot-${data.now.toISOString().slice(0, 10)}.png`,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (!path) return { method: "cancelled" };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await writeFile(path, bytes);
    return { method: "file", path };
  }
}
