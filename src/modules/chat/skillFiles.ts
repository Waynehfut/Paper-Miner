/**
 * Markdown skill files.
 *
 * One file per skill lives under `<Zotero data>/paperminer/skills/`:
 *
 *   ---
 *   name: 审稿人视角
 *   global: false
 *   ---
 *   The instruction text...
 *
 * Users can edit these files in any text editor and press "Reload from
 * folder" in preferences. The numeric filename prefix preserves display order.
 */

import {
  ensureDir,
  fileExists,
  getGlobal,
  getPluginDataDir,
  joinPath,
  readTextFile,
  writeTextFile,
} from "../../utils/fs";
import { log } from "../../utils/log";
import {
  MAX_QUICK_PHRASES,
  parseSkillsPayload,
  type QuickPhrase,
} from "./quickPhrases";

export const SKILLS_DIR_NAME = "skills";
export const SKILL_README_NAME = "README.md";

export function getSkillsDir(): string {
  return joinPath(getPluginDataDir(), SKILLS_DIR_NAME);
}

function basename(path: string): string {
  const parts = String(path || "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function stripQuotes(value: string): string {
  const raw = String(value || "").trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    try {
      return raw.startsWith('"')
        ? String(JSON.parse(raw))
        : raw.slice(1, -1).replace(/''/g, "'");
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function parseBoolean(value: string): boolean {
  return /^(true|yes|1|on)$/i.test(String(value || "").trim());
}

/** Parse one Markdown skill file. */
export function parseSkillMarkdown(
  text: string,
  fallbackLabel = "未命名技能",
): QuickPhrase | null {
  let source = String(text || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!source) return null;
  let label = "";
  let global = false;

  const frontmatter =
    /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(source);
  if (frontmatter) {
    for (const line of frontmatter[1].split("\n")) {
      const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (!match) continue;
      const key = match[1].toLowerCase();
      const value = match[2].trim();
      if (key === "name" || key === "label" || key === "title") {
        label = stripQuotes(value);
      } else if (key === "global" || key === "system") {
        global = parseBoolean(value);
      }
    }
    source = frontmatter[2].trim();
  } else {
    const heading = /^#\s+(.+)\n+([\s\S]*)$/.exec(source);
    if (heading) {
      label = heading[1].trim();
      source = heading[2].trim();
    }
  }

  if (!source) return null;
  return {
    label: label || fallbackLabel || source.slice(0, 18),
    prompt: source,
    ...(global ? { global: true } : {}),
  };
}

/** Serialise one skill to the canonical Markdown format. */
export function serializeSkillMarkdown(skill: QuickPhrase): string {
  const label = String(skill.label || "").trim() || "未命名技能";
  return [
    "---",
    `name: ${JSON.stringify(label)}`,
    `global: ${skill.global ? "true" : "false"}`,
    "---",
    "",
    String(skill.prompt || "").trim(),
    "",
  ].join("\n");
}

function orderFromName(name: string): number {
  const match = /^(\d+)[._\-\s]/.exec(name);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function labelFromFilename(name: string): string {
  return name
    .replace(/\.md$/i, "")
    .replace(/^\d+[._\-\s]*/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

/**
 * Read every `.md` skill file. Returns `null` when the directory does not
 * exist (so callers can keep the saved/preference copy), and `[]` when the
 * directory exists but contains no skills (an explicit empty list).
 */
export async function loadSkillFiles(
  dir = getSkillsDir(),
): Promise<QuickPhrase[] | null> {
  if (!(await fileExists(dir))) return null;
  const io = getGlobal().IOUtils;
  if (!io?.getChildren) return null;
  let children: string[];
  try {
    children = await io.getChildren(dir);
  } catch (error) {
    log("loadSkillFiles: cannot list", dir, error);
    return null;
  }
  const files = children
    .filter((path) => /\.md$/i.test(path))
    .filter(
      (path) =>
        basename(path).toLowerCase() !== SKILL_README_NAME.toLowerCase(),
    )
    .sort((a, b) => {
      const byOrder = orderFromName(basename(a)) - orderFromName(basename(b));
      return byOrder || basename(a).localeCompare(basename(b));
    });

  // Migrate the JSON file written by PaperMiner 0.1.6 and earlier.
  if (!files.length) {
    const legacyJSON = joinPath(dir, "skills.json");
    if (await fileExists(legacyJSON)) {
      const legacyRows = parseSkillsPayload(await readTextFile(legacyJSON));
      if (legacyRows.length) {
        await writeSkillFiles(legacyRows, dir);
        return legacyRows;
      }
    }
  }

  const rows: QuickPhrase[] = [];
  for (const path of files) {
    const name = basename(path);
    const text = await readTextFile(path);
    const row = parseSkillMarkdown(
      text,
      labelFromFilename(name) || "未命名技能",
    );
    if (row) rows.push(row);
    if (rows.length >= MAX_QUICK_PHRASES) break;
  }
  return rows;
}

function safeSlug(label: string, index: number): string {
  const cleaned = String(label || "")
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-\s]+|[.\-\s]+$/g, "")
    .slice(0, 60);
  return cleaned || `skill-${index + 1}`;
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let suffix = 2;
  while (used.has(name.toLowerCase())) {
    name = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

const README = `# PaperMiner conversation skills

One Markdown file per skill. Edit these files in any text editor, then press
"Reload from folder" in PaperMiner preferences.

\`\`\`markdown
---
name: 审稿人视角
global: false
---
请从审稿人的角度指出论文的主要缺陷，并给出修改建议。
\`\`\`

- \`name\`: skill name shown in the chat panel.
- \`global: true\`: send this instruction as a system rule on every turn.
- The numeric filename prefix (for example \`01-\`) controls display order.
- Deleting a file removes that skill. Adding a new \`.md\` file adds a skill.
`;

/** Write all skills as individual Markdown files, removing stale skill files. */
export async function writeSkillFiles(
  rows: QuickPhrase[],
  dir = getSkillsDir(),
): Promise<string[]> {
  const io = getGlobal().IOUtils;
  if (!io) return [];
  await ensureDir(dir);
  await writeTextFile(joinPath(dir, SKILL_README_NAME), README);

  const written: string[] = [];
  const used = new Set<string>();
  let index = 0;
  for (const row of rows) {
    const prompt = String(row.prompt || "").trim();
    if (!prompt) continue;
    const label = String(row.label || "").trim() || "未命名技能";
    const slug = uniqueName(safeSlug(label, index), used);
    const filename = `${String(index + 1).padStart(2, "0")}-${slug}.md`;
    const path = joinPath(dir, filename);
    await writeTextFile(path, serializeSkillMarkdown(row));
    written.push(path);
    index += 1;
    if (index >= MAX_QUICK_PHRASES) break;
  }

  // Remove the JSON skill file written by older PaperMiner versions; the
  // Markdown files are the canonical store now.
  const legacyJSON = joinPath(dir, "skills.json");
  if (await fileExists(legacyJSON)) {
    try {
      await io.remove(legacyJSON);
    } catch {
      // ignore
    }
  }

  const keep = new Set(written.map((path) => basename(path).toLowerCase()));
  try {
    const children = await io.getChildren(dir);
    for (const path of children) {
      const name = basename(path).toLowerCase();
      if (!name.endsWith(".md") || name === SKILL_README_NAME.toLowerCase()) {
        continue;
      }
      if (!keep.has(name)) await io.remove(path);
    }
  } catch (error) {
    log("writeSkillFiles: cannot clean stale files", error);
  }
  return written;
}
