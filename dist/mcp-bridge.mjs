#!/usr/bin/env node

// src/mcp/bridge.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "http";
import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

// src/ui/engine/smartNamer.ts
var TR_CHAR_MAP = {
  \u00E7: "c",
  \u00C7: "C",
  \u011F: "g",
  \u011E: "G",
  \u0131: "i",
  I: "I",
  \u0130: "I",
  \u00F6: "o",
  \u00D6: "O",
  \u015F: "s",
  \u015E: "S",
  \u00FC: "u",
  \u00DC: "U"
};
function normalizeAscii(str) {
  return str.replace(/[çÇğĞıIİöÖşŞüÜ]/g, (ch) => TR_CHAR_MAP[ch] ?? ch).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// src/ui/engine/designSpec.ts
function hexToRgb(hex) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  return {
    r: parseInt(m[1].slice(0, 2), 16),
    g: parseInt(m[1].slice(2, 4), 16),
    b: parseInt(m[1].slice(4, 6), 16)
  };
}
function getRelativeLuminance(r, g, b) {
  const toLinear = (channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}
function getSaturation(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  if (max === 0) return 0;
  return (max - min) / max;
}
function classifyColor(hex, count) {
  const rgb = hexToRgb(hex);
  if (!rgb) return { hex, role: "unknown", count, luminance: 0.5, saturation: 0 };
  const lum = getRelativeLuminance(rgb.r, rgb.g, rgb.b);
  const sat = getSaturation(rgb.r, rgb.g, rgb.b);
  return { hex, role: "", count, luminance: lum, saturation: sat };
}
function assignColorRoles(colors) {
  const sorted = [...colors].sort((a, b) => b.count - a.count);
  const used = /* @__PURE__ */ new Set();
  const getName = (base) => {
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let i = 2;
    while (used.has(`${base}-${i}`)) i++;
    used.add(`${base}-${i}`);
    return `${base}-${i}`;
  };
  for (const c of sorted) {
    if (c.saturation > 0.4) {
      if (c.luminance < 0.2) c.role = getName("accent-dark");
      else if (c.luminance > 0.65) c.role = getName("accent-light");
      else c.role = getName("accent");
    } else if (c.luminance > 0.85) {
      c.role = getName("white");
    } else if (c.luminance > 0.65) {
      c.role = getName("surface");
    } else if (c.luminance > 0.3) {
      c.role = getName("muted");
    } else if (c.luminance > 0.12) {
      c.role = getName("secondary");
    } else if (c.luminance > 0.03) {
      c.role = getName("primary");
    } else {
      c.role = getName("black");
    }
  }
  return sorted.sort((a, b) => a.luminance - b.luminance);
}
function extractTokens(node, tokens, depth = 0, ancestors = []) {
  if (node.tag === "Comment") return;
  tokens.totalNodes++;
  const currentPath = [...ancestors, node.name];
  if (node.cssVars) {
    for (const val of Object.values(node.cssVars)) {
      if (val.startsWith("#")) {
        tokens.colors.set(val.toLowerCase(), (tokens.colors.get(val.toLowerCase()) || 0) + 1);
      } else if (val.startsWith("var(")) {
        tokens.tokenVars.set(val, (tokens.tokenVars.get(val) || 0) + 1);
      }
    }
  }
  if (node.cssVarsMultiTheme) {
    for (const [varRef, modes] of Object.entries(node.cssVarsMultiTheme)) {
      tokens.multiThemeVars.set(varRef, modes);
    }
  }
  if (node.fontName?.family) {
    tokens.fontFamilies.add(`${node.fontName.family} (${node.fontName.style})`);
  }
  if (node.shadows && node.shadows.length > 0) {
    for (const s of node.shadows) tokens.shadows.add(s);
  }
  if (node.gradientFill) {
    tokens.gradients.add(node.gradientFill);
  }
  if (node.backdropBlur) {
    tokens.backdropBlurs.add(node.backdropBlur);
  }
  if (node.text && ["h1", "h2", "h3", "p", "span", "button"].includes(node.tag)) {
    tokens.totalText++;
    const typoTag = node.tag === "button" ? "span" : node.tag;
    tokens.typographyCounts.set(typoTag, (tokens.typographyCounts.get(typoTag) || 0) + 1);
  }
  const isCompNode = node.nodeType === "COMPONENT" || node.nodeType === "COMPONENT_SET" || node.nodeType === "INSTANCE" || node.variants && node.variants.length > 0;
  if (isCompNode) {
    tokens.components.push({
      name: node.name,
      path: currentPath.join(" > "),
      nodeType: node.nodeType || "INSTANCE",
      variants: node.variants ? node.variants.map((v) => `${v.property}=${v.value}`).join(", ") : "default",
      state: node.variantState
    });
  }
  for (const cls of node.classes) {
    const gapMatch = cls.match(/^gap-(\d+)$/);
    if (gapMatch) tokens.spacingValues.add(parseInt(gapMatch[1], 10) * 4);
    const padMatch = cls.match(/^p[xytblr]?-(\d+)$/);
    if (padMatch) tokens.spacingValues.add(parseInt(padMatch[1], 10) * 4);
    if (cls.startsWith("rounded")) tokens.radiusValues.add(cls);
  }
  if (depth === 1 && node.children.length > 0 && (node.tag === "div" || node.tag === "section")) {
    const hasHeading = node.children.some(
      (c) => ["h1", "h2", "h3"].includes(c.tag) && c.text
    );
    tokens.sections.push({ name: node.name, childCount: node.children.length, hasHeading });
  }
  for (const child of node.children) {
    extractTokens(child, tokens, depth + 1, currentPath);
  }
}
var TAG_SPECS = {
  h1: { size: 32, weight: 700, role: "Page title" },
  h2: { size: 24, weight: 600, role: "Section heading" },
  h3: { size: 20, weight: 600, role: "Card title / Subsection" },
  p: { size: 16, weight: 400, role: "Body text" },
  span: { size: 14, weight: 400, role: "Caption / Label" }
};
var RADIUS_MAP = {
  "rounded-sm": "2px",
  "rounded": "4px",
  "rounded-md": "6px",
  "rounded-lg": "8px",
  "rounded-xl": "12px",
  "rounded-2xl": "16px",
  "rounded-full": "9999px"
};
function generateDesignSpec(tree, layerName) {
  const tokens = {
    colors: /* @__PURE__ */ new Map(),
    tokenVars: /* @__PURE__ */ new Map(),
    multiThemeVars: /* @__PURE__ */ new Map(),
    typographyCounts: /* @__PURE__ */ new Map(),
    fontFamilies: /* @__PURE__ */ new Set(),
    shadows: /* @__PURE__ */ new Set(),
    gradients: /* @__PURE__ */ new Set(),
    backdropBlurs: /* @__PURE__ */ new Set(),
    spacingValues: /* @__PURE__ */ new Set(),
    radiusValues: /* @__PURE__ */ new Set(),
    components: [],
    sections: [],
    totalNodes: 0,
    totalText: 0
  };
  extractTokens(tree, tokens);
  const colorInfos = [...tokens.colors.entries()].map(
    ([hex, count]) => classifyColor(hex, count)
  );
  const namedColors = assignColorRoles(colorInfos);
  const spacingArr = [...tokens.spacingValues].sort((a, b) => a - b);
  const radii = [...tokens.radiusValues].map((r) => RADIUS_MAP[r] || r).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const yaml = ["---", "design_tokens:"];
  yaml.push("  colors:");
  for (const c of namedColors) {
    yaml.push(`    ${c.role}: "${c.hex}"`);
  }
  if (tokens.multiThemeVars.size > 0) {
    yaml.push("  theme_modes:");
    for (const [varRef, modes] of tokens.multiThemeVars) {
      yaml.push(`    "${varRef}": { light: "${modes.light}", dark: "${modes.dark}" }`);
    }
  }
  if (tokens.fontFamilies.size > 0) {
    yaml.push("  fonts:");
    for (const f of tokens.fontFamilies) {
      yaml.push(`    - "${f}"`);
    }
  }
  if (tokens.shadows.size > 0) {
    yaml.push("  shadows:");
    for (const s of tokens.shadows) {
      yaml.push(`    - "${s}"`);
    }
  }
  if (tokens.gradients.size > 0) {
    yaml.push("  gradients:");
    for (const g of tokens.gradients) {
      yaml.push(`    - "${g}"`);
    }
  }
  if (tokens.backdropBlurs.size > 0) {
    yaml.push("  glassmorphism:");
    for (const b of tokens.backdropBlurs) {
      yaml.push(`    - "${b}"`);
    }
  }
  if (tokens.tokenVars.size > 0) {
    yaml.push("  variables:");
    for (const [v, count] of tokens.tokenVars) {
      yaml.push(`    - ${v}  # used ${count}x`);
    }
  }
  yaml.push("  typography:");
  for (const [tag, count] of tokens.typographyCounts) {
    const spec = TAG_SPECS[tag] || { size: 16, weight: 400, role: tag };
    yaml.push(`    ${tag}: { size: ${spec.size}px, weight: ${spec.weight} }  # ${count}x`);
  }
  if (spacingArr.length > 0) {
    yaml.push(`  spacing: [${spacingArr.map((s) => `${s}px`).join(", ")}]`);
  }
  if (radii.length > 0) {
    yaml.push(`  radius: [${radii.join(", ")}]`);
  }
  yaml.push("---");
  const md = ["", `# ${layerName || tree.name}`, ""];
  md.push(
    `> ${tokens.totalNodes} elements, ${namedColors.length} colors, ${tokens.components.length} components, ${tokens.typographyCounts.size} type scales, ${spacingArr.length} spacing values.`
  );
  md.push("");
  if (namedColors.length > 0) {
    md.push("## Colors");
    md.push("");
    md.push("| Token | Value | Usage |");
    md.push("|-------|-------|-------|");
    for (const c of namedColors) {
      md.push(`| \`${c.role}\` | ${c.hex} | ${c.count}x |`);
    }
    md.push("");
  }
  if (tokens.multiThemeVars.size > 0) {
    md.push("## Multi-Theme Tokens (Light / Dark)");
    md.push("");
    md.push("| Variable | Light | Dark |");
    md.push("|----------|-------|------|");
    for (const [varRef, modes] of tokens.multiThemeVars) {
      md.push(`| \`${varRef}\` | ${modes.light} | ${modes.dark} |`);
    }
    md.push("");
  }
  if (tokens.typographyCounts.size > 0) {
    md.push("## Typography");
    md.push("");
    for (const [tag, count] of tokens.typographyCounts) {
      const spec = TAG_SPECS[tag] || { size: 16, weight: 400, role: tag };
      md.push(`- **${spec.role}** \`<${tag}>\` ${spec.size}px / ${spec.weight} (${count}x)`);
    }
    md.push("");
  }
  if (tokens.components.length > 0) {
    md.push("## Components & Variants");
    md.push("");
    for (const comp of tokens.components) {
      const stateTag = comp.state ? ` [state: ${comp.state}]` : "";
      md.push(`- **${comp.name}** (${comp.nodeType}) \u2014 Variants: \`${comp.variants}\`${stateTag} \u2014 Path: \`${comp.path}\``);
    }
    md.push("");
  }
  if (spacingArr.length > 0) {
    md.push("## Spacing");
    md.push("");
    md.push(`Grid: ${spacingArr.map((s) => `\`${s}px\``).join(" ")}`);
    md.push("");
  }
  if (radii.length > 0) {
    md.push("## Border Radius");
    md.push("");
    md.push(radii.map((r) => `\`${r}\``).join(" "));
    md.push("");
  }
  const a11yWarnings = [];
  const textColors = namedColors.filter(
    (c) => c.role.includes("black") || c.role.includes("primary") || c.role.includes("secondary") || c.role.includes("muted")
  );
  const bgColors = namedColors.filter(
    (c) => c.role.includes("white") || c.role.includes("surface")
  );
  let pairsChecked = 0;
  for (const tc of textColors) {
    for (const bg of bgColors) {
      pairsChecked++;
      const l1 = Math.max(tc.luminance, bg.luminance) + 0.05;
      const l2 = Math.min(tc.luminance, bg.luminance) + 0.05;
      const ratio = l1 / l2;
      if (ratio < 4.5) {
        const tierNote = ratio >= 3 ? "passes AA Large 3:1 only, fails normal text 4.5:1" : "fails both WCAG AA 4.5:1 and Large 3:1";
        a11yWarnings.push(
          `- \u26A0\uFE0F \`${tc.role}\` (${tc.hex}) on \`${bg.role}\` (${bg.hex}) \u2014 Contrast **${ratio.toFixed(2)}:1** (${tierNote})`
        );
      }
    }
  }
  md.push("## Accessibility Audit");
  md.push("");
  if (a11yWarnings.length > 0) {
    md.push("The following foreground/surface color pairs have insufficient WCAG 2.2 AA contrast:");
    md.push(...a11yWarnings);
  } else if (pairsChecked > 0) {
    md.push(`\u2713 All ${pairsChecked} tested foreground/surface color pairs meet WCAG 2.2 AA (\u2265 4.5:1).`);
  } else {
    md.push("\u2139\uFE0F Insufficient distinct foreground/background solid color tokens to evaluate contrast pairs.");
  }
  md.push("");
  return yaml.join("\n") + "\n" + md.join("\n");
}

// src/ui/engine/serializer.ts
function indent(depth) {
  return "  ".repeat(depth);
}
function classesToString(classes) {
  return classes.join(" ");
}
function responsiveClassesToString(responsive) {
  if (!responsive) return "";
  const parts = [];
  for (const [bp, classes] of Object.entries(responsive)) {
    for (const cls of classes) {
      parts.push(`${bp}:${cls}`);
    }
  }
  return parts.join(" ");
}
function mergeAllClasses(classes, responsive) {
  const base = classesToString(classes);
  const resp = responsiveClassesToString(responsive);
  return [base, resp].filter(Boolean).join(" ");
}
function cssPropToKebab(prop) {
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
function buildReactStyleAttr(node) {
  const styleParts = [];
  if (node.position) {
    if (node.position.top) styleParts.push(`top: '${node.position.top}'`);
    if (node.position.right) styleParts.push(`right: '${node.position.right}'`);
    if (node.position.bottom) styleParts.push(`bottom: '${node.position.bottom}'`);
    if (node.position.left) styleParts.push(`left: '${node.position.left}'`);
  }
  if (node.gradientFill) {
    styleParts.push(`backgroundImage: '${node.gradientFill}'`);
  }
  if (node.borders && node.borders.length > 0 && !node.cssVars?.borderColor) {
    styleParts.push(`border: '${node.borders[0]}'`);
  }
  if (node.cssVars) {
    for (const [k, v] of Object.entries(node.cssVars)) {
      styleParts.push(`${k}: '${v}'`);
    }
  }
  if (styleParts.length === 0) return null;
  return `style={{ ${styleParts.join(", ")} }}`;
}
function buildCssStyleAttr(node) {
  const parts = [];
  if (node.position) {
    parts.push("position: absolute");
    if (node.position.top) parts.push(`top: ${node.position.top}`);
    if (node.position.right) parts.push(`right: ${node.position.right}`);
    if (node.position.bottom) parts.push(`bottom: ${node.position.bottom}`);
    if (node.position.left) parts.push(`left: ${node.position.left}`);
  }
  if (node.gradientFill) {
    parts.push(`background-image: ${node.gradientFill}`);
  }
  if (node.borders && node.borders.length > 0 && !node.cssVars?.borderColor) {
    parts.push(`border: ${node.borders[0]}`);
  }
  if (node.cssVars) {
    for (const [k, v] of Object.entries(node.cssVars)) {
      parts.push(`${cssPropToKebab(k)}: ${v}`);
    }
  }
  if (parts.length === 0) return null;
  return `style="${parts.join("; ")}"`;
}
var STRUCTURAL_CLASS_RE = /^(flex|flex-row|flex-col|grid|justify-|items-|gap-|p-|px-|py-|relative|absolute|w-full|flex-1)/;
var PIXEL_SIZE_CLASS_RE = /^(w-\[\d+px\]|h-\[\d+px\]|aspect-\[)/;
function structuralSignature(node) {
  const childSig = node.children.map((c) => c.tag).join(",");
  return `${node.tag}|${node.classes.slice(0, 4).join(" ")}|${childSig}`;
}
function compressLightTree(node, level = "full", parentIsFlex = false) {
  if (level === "full") return node;
  const isFlexContainer = node.classes.includes("flex");
  let compressedChildren = node.children.map(
    (ch) => compressLightTree(ch, level, isFlexContainer)
  );
  if (compressedChildren.length >= 3) {
    const folded = [];
    let i = 0;
    while (i < compressedChildren.length) {
      const baseSig = structuralSignature(compressedChildren[i]);
      let j = i + 1;
      while (j < compressedChildren.length && compressedChildren[j].children.length > 0 && structuralSignature(compressedChildren[j]) === baseSig) {
        j++;
      }
      const runLen = j - i;
      if (runLen >= 3) {
        folded.push(compressedChildren[i]);
        folded.push(compressedChildren[i + 1]);
        const omitted = compressedChildren.slice(i + 2, j);
        const sampleLabels = omitted.slice(0, 3).map((n) => n.name).join(", ");
        folded.push({
          tag: "Comment",
          name: "repeated-siblings",
          classes: [],
          text: `+${omitted.length} similar <${compressedChildren[i].tag}> items (${sampleLabels}${omitted.length > 3 ? ", ..." : ""})`,
          children: []
        });
        i = j;
      } else {
        folded.push(compressedChildren[i]);
        i++;
      }
    }
    compressedChildren = folded;
  }
  let nextClasses = [...node.classes];
  if (level === "compact") {
    if (parentIsFlex && node.tag !== "img" && !node.position) {
      nextClasses = nextClasses.filter((c) => !PIXEL_SIZE_CLASS_RE.test(c));
    }
  } else if (level === "sparse") {
    nextClasses = nextClasses.filter((c) => STRUCTURAL_CLASS_RE.test(c));
  }
  let nextCssVars = node.cssVars;
  if (level === "sparse" && node.cssVars) {
    const tokenOnly = {};
    for (const [k, v] of Object.entries(node.cssVars)) {
      if (v.startsWith("var(")) tokenOnly[k] = v;
    }
    nextCssVars = Object.keys(tokenOnly).length > 0 ? tokenOnly : void 0;
  }
  return {
    ...node,
    classes: nextClasses,
    gradientFill: level === "sparse" ? void 0 : node.gradientFill,
    borders: level === "sparse" ? void 0 : node.borders,
    cssVars: nextCssVars,
    children: compressedChildren
  };
}
function nodeToJSX(node, depth = 0) {
  const ind = indent(depth);
  const tag = node.tag;
  if (tag === "Comment") {
    return `${ind}{/* ${node.text} */}`;
  }
  if (tag === "Icon") {
    return `${ind}<Icon name="${node.iconName ?? node.name}" />`;
  }
  if (tag === "img") {
    const cls = mergeAllClasses(node.classes, node.responsive);
    const clsAttr = cls ? ` className="${cls}"` : "";
    return `${ind}<img${clsAttr} alt="${node.name}" />`;
  }
  const attrs = [];
  const allClasses = [...node.classes];
  if (node.position && !allClasses.includes("absolute")) allClasses.unshift("absolute");
  const mergedCls = mergeAllClasses(allClasses, node.responsive);
  if (mergedCls) attrs.push(`className="${mergedCls}"`);
  const styleAttr = buildReactStyleAttr(node);
  if (styleAttr) attrs.push(styleAttr);
  const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
  let variantComment = "";
  if (node.variants && node.variants.length > 0) {
    const variantStr = node.variants.map((v) => `${v.property}=${v.value}`).join(", ");
    const stateStr = node.variantState ? ` [state: ${node.variantState}]` : "";
    variantComment = `${ind}{/* Variants: ${variantStr}${stateStr} */}
`;
  }
  if (node.text && node.children.length === 0) {
    return `${variantComment}${ind}<${tag}${attrStr}>${node.text}</${tag}>`;
  }
  if (node.children.length === 0) {
    return `${variantComment}${ind}<${tag}${attrStr} />`;
  }
  const childrenStr = node.children.map((child) => nodeToJSX(child, depth + 1)).join("\n");
  return `${variantComment}${ind}<${tag}${attrStr}>
${childrenStr}
${ind}</${tag}>`;
}
function toCleanJSX(tree) {
  return nodeToJSX(tree, 0);
}
function nodeToMD(node, depth = 0) {
  const mdIndent = "  ".repeat(depth);
  if (node.tag === "Comment") {
    return `${mdIndent}- _(${node.text})_`;
  }
  if (node.tag === "Icon") {
    return `${mdIndent}- [Icon] "${node.iconName ?? node.name}"`;
  }
  if (node.tag === "img") {
    return `${mdIndent}- [Image] "${node.name}"`;
  }
  if (node.tag === "h1" && node.text) return `${mdIndent}# ${node.text}`;
  if (node.tag === "h2" && node.text) return `${mdIndent}## ${node.text}`;
  if (node.tag === "h3" && node.text) return `${mdIndent}### ${node.text}`;
  if (node.text && node.children.length === 0) {
    const prefix = node.tag === "button" ? "[Button]" : "[Text]";
    return `${mdIndent}- ${prefix}: "${node.text}"`;
  }
  const layout = node.classes.includes("flex-row") ? " [\u2192 row]" : node.classes.includes("flex-col") ? " [\u2193 col]" : "";
  const variantTag = node.variants && node.variants.length > 0 ? ` {${node.variants.map((v) => `${v.property}=${v.value}`).join(", ")}${node.variantState ? ` [${node.variantState}]` : ""}}` : "";
  const rolePrefix = node.tag === "button" ? "[Button] " : "";
  const header = `${mdIndent}- ${rolePrefix}**${node.name}**${layout}${variantTag}`;
  if (node.children.length === 0) return header;
  const childrenStr = node.children.map((child) => nodeToMD(child, depth + 1)).join("\n");
  return `${header}
${childrenStr}`;
}
function toSemanticMD(tree) {
  return nodeToMD(tree, 0);
}
function nodeToHTML(node, depth = 0) {
  const ind = indent(depth);
  if (node.tag === "Comment") {
    return `${ind}<!-- ${node.text} -->`;
  }
  if (node.tag === "Icon") {
    return `${ind}<span data-icon="${node.iconName ?? node.name}" aria-label="${node.name}"></span>`;
  }
  const tag = node.tag;
  if (tag === "img") {
    const cls = mergeAllClasses(node.classes, node.responsive);
    const clsAttr = cls ? ` class="${cls}"` : "";
    return `${ind}<img${clsAttr} alt="${node.name}" />`;
  }
  const attrs = [];
  const allClasses = [...node.classes];
  if (node.position && !allClasses.includes("absolute")) allClasses.unshift("absolute");
  const mergedCls = mergeAllClasses(allClasses, node.responsive);
  if (mergedCls) attrs.push(`class="${mergedCls}"`);
  const styleAttr = buildCssStyleAttr(node);
  if (styleAttr) attrs.push(styleAttr);
  const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
  if (node.text && node.children.length === 0) {
    return `${ind}<${tag}${attrStr}>${node.text}</${tag}>`;
  }
  if (node.children.length === 0) {
    const selfClosing = ["img", "br", "hr", "input"];
    if (selfClosing.includes(tag)) return `${ind}<${tag}${attrStr} />`;
    return `${ind}<${tag}${attrStr}></${tag}>`;
  }
  const childrenStr = node.children.map((child) => nodeToHTML(child, depth + 1)).join("\n");
  return `${ind}<${tag}${attrStr}>
${childrenStr}
${ind}</${tag}>`;
}
function toHTML(tree) {
  return nodeToHTML(tree, 0);
}
function toTailwind(tree) {
  const jsxBody = nodeToJSX(tree, 2);
  return `export default function ${sanitizeComponentName(tree.name)}() {
  return (
${jsxBody}
  );
}`;
}
function findDirectText(node) {
  if (node.text) return node.text;
  const textChild = node.children.find((c) => c.text && c.children.length === 0);
  return textChild?.text;
}
function toShadcnJSX(tree) {
  const imports = /* @__PURE__ */ new Set();
  function nodeToShadcn(node, depth = 0) {
    const ind = indent(depth);
    if (node.tag === "Comment") {
      return `${ind}{/* ${node.text} */}`;
    }
    const nameLower = node.name.toLowerCase();
    const isButton = node.tag === "button" || node.children.length <= 2 && /\b(btn|button|cta)\b/.test(nameLower);
    const isInput = node.tag === "input" || node.children.length <= 2 && /\b(input|field|search-bar)\b/.test(nameLower);
    const isCard = node.children.length >= 2 && nameLower.startsWith("card");
    if (isButton) {
      imports.add("Button");
      const label = findDirectText(node) ?? "Action";
      const isOutline = node.borders && node.borders.length > 0 && !node.cssVars?.backgroundColor;
      const variantAttr = isOutline ? ' variant="outline"' : "";
      const disabledAttr = node.variantState === "disabled" ? " disabled" : "";
      return `${ind}<Button${variantAttr}${disabledAttr}>${label}</Button>`;
    }
    if (isInput) {
      imports.add("Input");
      const placeholder = findDirectText(node) ?? "Enter value...";
      return `${ind}<Input placeholder="${placeholder.replace(/"/g, "&quot;")}" />`;
    }
    if (isCard) {
      imports.add("Card");
      const cls = mergeAllClasses(node.classes, node.responsive);
      const clsAttr = cls ? ` className="${cls}"` : "";
      const childrenStr2 = node.children.map((ch) => nodeToShadcn(ch, depth + 1)).join("\n");
      return `${ind}<Card${clsAttr}>
${childrenStr2}
${ind}</Card>`;
    }
    if (node.tag === "Icon" || node.tag === "img" || node.children.length === 0) {
      return nodeToJSX(node, depth);
    }
    const attrs = [];
    const allClasses = [...node.classes];
    if (node.position && !allClasses.includes("absolute")) allClasses.unshift("absolute");
    const mergedCls = mergeAllClasses(allClasses, node.responsive);
    if (mergedCls) attrs.push(`className="${mergedCls}"`);
    const styleAttr = buildReactStyleAttr(node);
    if (styleAttr) attrs.push(styleAttr);
    const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
    const childrenStr = node.children.map((ch) => nodeToShadcn(ch, depth + 1)).join("\n");
    return `${ind}<${node.tag}${attrStr}>
${childrenStr}
${ind}</${node.tag}>`;
  }
  const body = nodeToShadcn(tree, 2);
  const importArray = Array.from(imports);
  const importHeader = importArray.length > 0 ? importArray.map((comp) => `import { ${comp} } from "@/components/ui/${comp.toLowerCase()}";`).join("\n") + "\n\n" : "";
  return `${importHeader}export default function ${sanitizeComponentName(tree.name)}() {
  return (
${body}
  );
}`;
}
function toVueSFC(tree) {
  function nodeToVue(node, depth = 0) {
    const ind = indent(depth);
    if (node.tag === "Comment") return `${ind}<!-- ${node.text} -->`;
    if (node.tag === "Icon") {
      return `${ind}<span data-icon="${node.iconName ?? node.name}" aria-label="${node.name}" />`;
    }
    if (node.tag === "img") {
      const cls = mergeAllClasses(node.classes, node.responsive);
      const clsAttr = cls ? ` class="${cls}"` : "";
      return `${ind}<img${clsAttr} alt="${node.name}" />`;
    }
    const attrs = [];
    const allClasses = [...node.classes];
    if (node.position && !allClasses.includes("absolute")) allClasses.unshift("absolute");
    const merged = mergeAllClasses(allClasses, node.responsive);
    if (merged) attrs.push(`class="${merged}"`);
    const styleAttr = buildCssStyleAttr(node);
    if (styleAttr) attrs.push(styleAttr);
    const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
    let variantComment = "";
    if (node.variants && node.variants.length > 0) {
      const variantStr = node.variants.map((v) => `${v.property}=${v.value}`).join(", ");
      variantComment = `${ind}<!-- Variants: ${variantStr} -->
`;
    }
    if (node.text && node.children.length === 0) {
      return `${variantComment}${ind}<${node.tag}${attrStr}>${node.text}</${node.tag}>`;
    }
    if (node.children.length === 0) {
      return `${variantComment}${ind}<${node.tag}${attrStr} />`;
    }
    const childrenStr = node.children.map((c) => nodeToVue(c, depth + 1)).join("\n");
    return `${variantComment}${ind}<${node.tag}${attrStr}>
${childrenStr}
${ind}</${node.tag}>`;
  }
  return `<script setup lang="ts">
// ${tree.name} \u2014 Vue 3 SFC
</script>

<template>
${nodeToVue(tree, 1)}
</template>`;
}
function escapeSvelteText(text) {
  return text.replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
}
function toSvelte5(tree) {
  function nodeToSvelte(node, depth = 0) {
    const ind = indent(depth);
    if (node.tag === "Comment") return `${ind}<!-- ${node.text} -->`;
    if (node.tag === "Icon") {
      return `${ind}<span data-icon="${node.iconName ?? node.name}" aria-label="${node.name}"></span>`;
    }
    if (node.tag === "img") {
      const cls = mergeAllClasses(node.classes, node.responsive);
      const clsAttr = cls ? ` class="${cls}"` : "";
      return `${ind}<img${clsAttr} alt="${node.name}" />`;
    }
    const attrs = [];
    const allClasses = [...node.classes];
    if (node.position && !allClasses.includes("absolute")) allClasses.unshift("absolute");
    const merged = mergeAllClasses(allClasses, node.responsive);
    if (merged) attrs.push(`class="${merged}"`);
    const styleAttr = buildCssStyleAttr(node);
    if (styleAttr) attrs.push(styleAttr);
    const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
    if (node.text && node.children.length === 0) {
      return `${ind}<${node.tag}${attrStr}>${escapeSvelteText(node.text)}</${node.tag}>`;
    }
    if (node.children.length === 0) {
      return `${ind}<${node.tag}${attrStr}></${node.tag}>`;
    }
    const childrenStr = node.children.map((c) => nodeToSvelte(c, depth + 1)).join("\n");
    return `${ind}<${node.tag}${attrStr}>
${childrenStr}
${ind}</${node.tag}>`;
  }
  const safeTitle = tree.name.replace(/'/g, "\\'");
  return `<script lang="ts">
  let { title = '${safeTitle}' } = $props();
</script>

${nodeToSvelte(tree, 0)}`;
}
function sanitizeComponentName(name) {
  const cleaned = normalizeAscii(name).replace(/[^a-zA-Z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join("");
  if (/^\d/.test(cleaned)) return `Component${cleaned}`;
  return cleaned || "Component";
}

// src/ui/engine/dtcgExporter.ts
function getSaturation2(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  if (max === 0) return 0;
  return (max - min) / max;
}
var RADIUS_MAP2 = {
  "rounded-sm": "2px",
  "rounded": "4px",
  "rounded-md": "6px",
  "rounded-lg": "8px",
  "rounded-xl": "12px",
  "rounded-2xl": "16px",
  "rounded-full": "9999px"
};
var SPACING_NAMES = {
  4: "xs",
  8: "sm",
  12: "md",
  16: "base",
  20: "lg",
  24: "xl",
  32: "2xl",
  48: "3xl",
  64: "4xl"
};
function spacingName(px) {
  return SPACING_NAMES[px] || `${px}`;
}
var TAG_SPECS2 = {
  h1: { size: 32, weight: 700, role: "heading-xl" },
  h2: { size: 24, weight: 600, role: "heading-lg" },
  h3: { size: 20, weight: 600, role: "heading-md" },
  p: { size: 16, weight: 400, role: "body" },
  span: { size: 14, weight: 400, role: "caption" }
};
function extractDTCGTokens(node, tokens) {
  if (node.tag === "Comment") return;
  if (node.cssVars) {
    for (const val of Object.values(node.cssVars)) {
      if (val.startsWith("#")) {
        tokens.colors.set(val.toLowerCase(), (tokens.colors.get(val.toLowerCase()) || 0) + 1);
      }
    }
  }
  if (node.cssVarsMultiTheme) {
    for (const [varRef, modes] of Object.entries(node.cssVarsMultiTheme)) {
      tokens.multiThemeVars.set(varRef, modes);
    }
  }
  if (node.fontName?.family) {
    tokens.fontFamilies.add(node.fontName.family);
  }
  if (node.text && ["h1", "h2", "h3", "p", "span"].includes(node.tag)) {
    tokens.typographyCounts.set(node.tag, (tokens.typographyCounts.get(node.tag) || 0) + 1);
  }
  if (node.shadows) {
    for (const s of node.shadows) tokens.shadows.add(s);
  }
  if (node.gradientFill) {
    tokens.gradients.add(node.gradientFill);
  }
  if (node.backdropBlur) {
    tokens.backdropBlurs.add(node.backdropBlur);
  }
  for (const cls of node.classes) {
    const gapMatch = cls.match(/^gap-(\d+)$/);
    if (gapMatch) tokens.spacingValues.add(parseInt(gapMatch[1], 10) * 4);
    const padMatch = cls.match(/^p[xytblr]?-(\d+)$/);
    if (padMatch) tokens.spacingValues.add(parseInt(padMatch[1], 10) * 4);
    if (cls.startsWith("rounded")) tokens.radiusValues.add(cls);
  }
  for (const child of node.children) {
    extractDTCGTokens(child, tokens);
  }
}
function assignRole(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return "unknown";
  const lum = getRelativeLuminance(rgb.r, rgb.g, rgb.b);
  const sat = getSaturation2(rgb.r, rgb.g, rgb.b);
  if (sat > 0.4) {
    if (lum < 0.2) return "accent-dark";
    if (lum > 0.65) return "accent-light";
    return "accent";
  }
  if (lum > 0.85) return "white";
  if (lum > 0.65) return "surface";
  if (lum > 0.3) return "muted";
  if (lum > 0.12) return "secondary";
  if (lum > 0.03) return "primary";
  return "black";
}
function generateDTCG(tree, layerName) {
  const tokens = {
    colors: /* @__PURE__ */ new Map(),
    multiThemeVars: /* @__PURE__ */ new Map(),
    fontFamilies: /* @__PURE__ */ new Set(),
    typographyCounts: /* @__PURE__ */ new Map(),
    spacingValues: /* @__PURE__ */ new Set(),
    radiusValues: /* @__PURE__ */ new Set(),
    shadows: /* @__PURE__ */ new Set(),
    gradients: /* @__PURE__ */ new Set(),
    backdropBlurs: /* @__PURE__ */ new Set()
  };
  extractDTCGTokens(tree, tokens);
  const dtcg = {
    $name: `TokenSqueezer \u2014 ${layerName || tree.name}`,
    $description: `Design tokens extracted from Figma layer "${layerName || tree.name}" by TokenSqueezer v1.4.0`
  };
  if (tokens.colors.size > 0 || tokens.multiThemeVars.size > 0) {
    const usedRoles = /* @__PURE__ */ new Set();
    dtcg.color = {};
    const sorted = [...tokens.colors.entries()].sort((a, b) => b[1] - a[1]);
    for (const [hex] of sorted) {
      let role = assignRole(hex);
      if (usedRoles.has(role)) {
        let i = 2;
        while (usedRoles.has(`${role}-${i}`)) i++;
        role = `${role}-${i}`;
      }
      usedRoles.add(role);
      dtcg.color[role] = { $value: hex, $type: "color" };
    }
    for (const [varRef, modes] of tokens.multiThemeVars) {
      const cleanName = varRef.replace(/^var\(--/, "").replace(/\)$/, "");
      dtcg.color[cleanName] = {
        $value: modes.light,
        $type: "color",
        $extensions: {
          "com.tokensqueezer.modes": {
            light: modes.light,
            dark: modes.dark
          }
        }
      };
    }
  }
  if (tokens.typographyCounts.size > 0) {
    dtcg.typography = {};
    for (const [tag] of tokens.typographyCounts) {
      const spec = TAG_SPECS2[tag] || { size: 16, weight: 400, role: tag };
      const families = [...tokens.fontFamilies];
      dtcg.typography[spec.role] = {
        $value: {
          fontFamily: families[0] || "system-ui",
          fontSize: `${spec.size}px`,
          fontWeight: spec.weight,
          lineHeight: 1.5
        },
        $type: "typography"
      };
    }
  }
  if (tokens.fontFamilies.size > 0) {
    dtcg.fontFamily = {};
    for (const family of tokens.fontFamilies) {
      const key = family.toLowerCase().replace(/\s+/g, "-");
      dtcg.fontFamily[key] = { $value: family, $type: "fontFamily" };
    }
  }
  if (tokens.spacingValues.size > 0) {
    dtcg.spacing = {};
    const sorted = [...tokens.spacingValues].sort((a, b) => a - b);
    for (const px of sorted) {
      dtcg.spacing[spacingName(px)] = { $value: `${px}px`, $type: "dimension" };
    }
  }
  if (tokens.radiusValues.size > 0) {
    dtcg.borderRadius = {};
    const radii = [...tokens.radiusValues].map((r) => ({ tw: r, px: RADIUS_MAP2[r] || r })).filter((v, i, a) => a.findIndex((x) => x.px === v.px) === i).sort((a, b) => parseInt(a.px, 10) - parseInt(b.px, 10));
    for (const { tw, px } of radii) {
      const key = tw.replace("rounded-", "").replace("rounded", "default");
      dtcg.borderRadius[key] = { $value: px, $type: "dimension" };
    }
  }
  if (tokens.shadows.size > 0) {
    dtcg.shadow = {};
    let i = 1;
    for (const shadow of tokens.shadows) {
      dtcg.shadow[`shadow-${i}`] = { $value: shadow, $type: "shadow" };
      i++;
    }
  }
  if (tokens.gradients.size > 0) {
    dtcg.gradient = {};
    let i = 1;
    for (const grad of tokens.gradients) {
      dtcg.gradient[`gradient-${i}`] = { $value: grad, $type: "gradient" };
      i++;
    }
  }
  if (tokens.backdropBlurs.size > 0) {
    dtcg.blur = {};
    let i = 1;
    for (const blur of tokens.backdropBlurs) {
      dtcg.blur[`backdrop-${i}`] = { $value: blur, $type: "dimension" };
      i++;
    }
  }
  return JSON.stringify(dtcg, null, 2);
}

// src/mcp/bridge.ts
var PKG_VERSION = "1.4.1";
var DAEMON_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1e3;
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(`tokensqueezer-mcp v${PKG_VERSION}
`);
  process.exit(0);
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    [
      `TokenSqueezer MCP Bridge v${PKG_VERSION}`,
      "Companion local MCP server for the TokenSqueezer Figma plugin:",
      "https://www.figma.com/community/plugin/1665050072562427069/",
      "",
      "Usage:",
      "  npx -y tokensqueezer-mcp@latest [--port 3333]",
      "",
      "Options:",
      "  --port <number>   Local HTTP bridge port for Figma plugin (default: 3333)",
      "  --stop            Stop any running background HTTP bridge daemon on the port",
      "  -v, --version     Print version",
      "  -h, --help        Show help",
      ""
    ].join("\n")
  );
  process.exit(0);
}
var portArg = process.argv.indexOf("--port");
var PORT = portArg !== -1 && process.argv[portArg + 1] ? parseInt(process.argv[portArg + 1], 10) || 3333 : 3333;
var IS_DAEMON = process.argv.includes("--daemon");
var IS_STOP = process.argv.includes("--stop");
function log(msg) {
  if (IS_DAEMON) return;
  process.stderr.write(`[TokenSqueezer MCP] ${msg}
`);
}
var STATE_DIR = join(homedir(), ".tokensqueezer");
var STATE_FILE = join(STATE_DIR, PORT === 3333 ? "state.json" : `state-${PORT}.json`);
var ANNOTATIONS_FILE = join(
  STATE_DIR,
  PORT === 3333 ? "annotations.json" : `annotations-${PORT}.json`
);
var latestContext = null;
var previousContext = null;
var latestFormats = null;
var pendingAnnotations = [];
var lastPluginPollAt = null;
var lastLoadedStateMtime = 0;
var lastLoadedAnnotationsMtime = 0;
function ensureStateDir() {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 448 });
  } catch {
  }
}
function writeJsonAtomic(filePath, payload) {
  try {
    ensureStateDir();
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload), { encoding: "utf8", mode: 384 });
    renameSync(tmpPath, filePath);
  } catch {
  }
}
function syncStateFromDisk(force = false) {
  try {
    if (!existsSync(STATE_FILE)) return;
    const st = statSync(STATE_FILE);
    if (!force && st.mtimeMs === lastLoadedStateMtime) return;
    const raw = readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    latestContext = parsed.latestContext ?? null;
    previousContext = parsed.previousContext ?? null;
    latestFormats = parsed.latestFormats ?? null;
    lastLoadedStateMtime = st.mtimeMs;
  } catch {
  }
}
function saveStateToDisk() {
  const payload = {
    version: PKG_VERSION,
    latestContext,
    previousContext,
    latestFormats,
    updatedAt: Date.now()
  };
  writeJsonAtomic(STATE_FILE, payload);
  try {
    if (existsSync(STATE_FILE)) {
      lastLoadedStateMtime = statSync(STATE_FILE).mtimeMs;
    }
  } catch {
  }
}
function syncAnnotationsFromDisk(force = false) {
  try {
    if (!existsSync(ANNOTATIONS_FILE)) {
      pendingAnnotations = [];
      lastLoadedAnnotationsMtime = 0;
      return;
    }
    const st = statSync(ANNOTATIONS_FILE);
    if (!force && st.mtimeMs === lastLoadedAnnotationsMtime) return;
    const raw = readFileSync(ANNOTATIONS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      pendingAnnotations = parsed;
    }
    lastLoadedAnnotationsMtime = st.mtimeMs;
  } catch {
  }
}
function saveAnnotationsToDisk() {
  writeJsonAtomic(ANNOTATIONS_FILE, pendingAnnotations);
  try {
    if (existsSync(ANNOTATIONS_FILE)) {
      lastLoadedAnnotationsMtime = statSync(ANNOTATIONS_FILE).mtimeMs;
    }
  } catch {
  }
}
async function probeLocalDaemon(timeoutMs = 400) {
  for (const host of ["127.0.0.1", "localhost"]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://${host}:${PORT}/health`, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.status === "ok") {
        return {
          ok: true,
          version: data.version,
          lastPluginPollAt: data.lastPluginPollAt ?? null
        };
      }
    } catch {
      clearTimeout(timer);
    }
  }
  return null;
}
async function stopLocalDaemon(timeoutMs = 450) {
  for (const host of ["127.0.0.1", "localhost"]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://${host}:${PORT}/shutdown`, {
        method: "POST",
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {
      clearTimeout(timer);
    }
  }
  return false;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function ensureDaemonRunning() {
  const existing = await probeLocalDaemon(350);
  if (existing?.ok) {
    if (existing.version === PKG_VERSION) {
      return;
    }
    await stopLocalDaemon(400);
    await sleep(140);
  }
  try {
    const scriptPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [scriptPath, "--daemon", "--port", String(PORT)], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch (err) {
    log(`Warning: could not spawn background daemon: ${err}`);
    return;
  }
  for (let i = 0; i < 8; i++) {
    await sleep(80);
    const ready = await probeLocalDaemon(250);
    if (ready?.ok) {
      log(`Background HTTP bridge v${PKG_VERSION} active on http://localhost:${PORT}`);
      return;
    }
  }
}
async function enqueueAnnotationReliable(item) {
  for (const host of ["127.0.0.1", "localhost"]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 450);
    try {
      const res = await fetch(`http://${host}:${PORT}/annotations/enqueue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) return;
    } catch {
      clearTimeout(timer);
    }
  }
  syncAnnotationsFromDisk(true);
  pendingAnnotations.push(item);
  saveAnnotationsToDisk();
}
function countTreeNodes(node) {
  if (!node || node.tag === "Comment") return 0;
  return 1 + node.children.reduce((acc, ch) => acc + countTreeNodes(ch), 0);
}
function collectLayerNames(node, out = /* @__PURE__ */ new Set()) {
  if (!node || node.tag === "Comment") return out;
  out.add(node.name);
  for (const ch of node.children) collectLayerNames(ch, out);
  return out;
}
function renderFormatFromTree(tree, layerName, output, compression) {
  const working = output === "spec" || output === "dtcg" ? tree : compressLightTree(tree, compression);
  switch (output) {
    case "jsx":
      return toCleanJSX(working);
    case "shadcn":
      return toShadcnJSX(working);
    case "vue":
      return toVueSFC(working);
    case "svelte":
      return toSvelte5(working);
    case "md":
      return toSemanticMD(working);
    case "html":
      return toHTML(working);
    case "tailwind":
      return toTailwind(working);
    case "spec":
      return generateDesignSpec(tree, layerName);
    case "dtcg":
      return generateDTCG(tree, layerName);
    default:
      return toSemanticMD(working);
  }
}
function resolveRequestedFormat(output, compression) {
  if (latestContext?.tree && compression && compression !== latestContext.compressionLevel) {
    return renderFormatFromTree(latestContext.tree, latestContext.layerName, output, compression);
  }
  const formatMap = {
    jsx: latestFormats?.jsx,
    shadcn: latestFormats?.shadcn,
    vue: latestFormats?.vue,
    svelte: latestFormats?.svelte,
    md: latestFormats?.md,
    html: latestFormats?.html,
    tailwind: latestFormats?.tailwind,
    spec: latestFormats?.designSpec,
    dtcg: latestFormats?.dtcg
  };
  if (formatMap[output]) return formatMap[output];
  if (latestContext?.tree) {
    return renderFormatFromTree(
      latestContext.tree,
      latestContext.layerName,
      output,
      compression ?? latestContext.compressionLevel
    );
  }
  return latestContext?.output || "";
}
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Access-Control-Request-Private-Network"
  );
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}
function isLoopbackAddress(addr) {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.") || addr.startsWith("::ffff:127.");
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
function startHttpBridgeServer(enableIdleTimeout) {
  syncStateFromDisk(true);
  syncAnnotationsFromDisk(true);
  let idleTimer = null;
  const resetIdleTimer = () => {
    if (!enableIdleTimeout) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      httpServer.close(() => process.exit(0));
    }, DAEMON_IDLE_TIMEOUT_MS);
  };
  const httpServer = createServer(async (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden: loopback connections only" }));
      return;
    }
    resetIdleTimer();
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/shutdown") {
      if (req.headers.origin !== void 0) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => {
        httpServer.close(() => process.exit(0));
      }, 25);
      return;
    }
    if (req.method === "POST" && req.url === "/annotations/enqueue") {
      if (req.headers.origin !== void 0) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        if (parsed?.item) {
          syncAnnotationsFromDisk();
          pendingAnnotations.push(parsed.item);
          saveAnnotationsToDisk();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, count: pendingAnnotations.length }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      syncStateFromDisk();
      syncAnnotationsFromDisk();
      lastPluginPollAt = Date.now();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          version: PKG_VERSION,
          hasContext: latestContext !== null,
          layerName: latestContext?.layerName ?? null,
          timestamp: latestContext?.timestamp ?? null,
          hasImage: !!latestContext?.imageDataUrl,
          pendingAnnotationsCount: pendingAnnotations.length,
          lastPluginPollAt
        })
      );
      return;
    }
    if (req.method === "POST" && req.url === "/annotations/consume") {
      syncAnnotationsFromDisk();
      lastPluginPollAt = Date.now();
      const batch = [...pendingAnnotations];
      pendingAnnotations = [];
      saveAnnotationsToDisk();
      if (batch.length > 0) {
        log(`Delivered ${batch.length} annotation(s) to Figma plugin`);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, annotations: batch }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/context")) {
      syncStateFromDisk();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          context: latestContext,
          allFormats: latestFormats
        })
      );
      return;
    }
    if (req.method === "POST" && req.url === "/context") {
      try {
        const body = await readBody(req);
        const data = JSON.parse(body);
        syncStateFromDisk();
        previousContext = latestContext ? { ...latestContext } : null;
        latestContext = {
          layerName: data.layerName || "unknown",
          nodeId: data.nodeId || null,
          format: data.format || "JSX",
          compressionLevel: data.compressionLevel || "full",
          output: data.output || "",
          rawTokens: data.rawTokens || 0,
          squeezedTokens: data.squeezedTokens || 0,
          savedPercentage: data.savedPercentage || 0,
          imageDataUrl: data.imageDataUrl || null,
          imageDimensions: data.imageDimensions || null,
          tree: data.tree || null,
          timestamp: Date.now()
        };
        latestFormats = data.allFormats || null;
        saveStateToDisk();
        log(
          `Context updated: "${latestContext.layerName}" (${latestContext.squeezedTokens} tokens, ${latestContext.format}, compression=${latestContext.compressionLevel}${latestContext.imageDataUrl ? ", +Vision" : ""})`
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });
  let triedIpv4Fallback = false;
  httpServer.on("error", (err) => {
    if (!triedIpv4Fallback && (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL" || err.code === "EINVAL")) {
      triedIpv4Fallback = true;
      httpServer.listen(PORT, "127.0.0.1");
      return;
    }
    if (err.code === "EADDRINUSE") {
      if (IS_DAEMON) {
        process.exit(0);
      }
      log(`Port ${PORT} is already active \u2014 sharing local bridge state.`);
      return;
    }
    log(`HTTP bridge listener warning (${err.code || "ERROR"}): ${err.message}`);
  });
  httpServer.on("listening", () => {
    resetIdleTimer();
    const modeLabel = triedIpv4Fallback ? "127.0.0.1 IPv4 loopback" : "localhost + 127.0.0.1 dual-stack loopback";
    log(`HTTP bridge v${PKG_VERSION} listening on http://localhost:${PORT} (${modeLabel})`);
    log(`Ready \u2014 open TokenSqueezer in Figma and enable MCP Mode (Ctrl+C to stop).`);
  });
  httpServer.listen({ port: PORT, host: "::", ipv6Only: false });
}
function createMcpServer() {
  const mcp = new McpServer({
    name: "tokensqueezer",
    version: PKG_VERSION
  });
  mcp.tool(
    "get_figma_context",
    "Get the current squeezed Figma design context + optional multimodal PNG preview. Supports 9 output formats and on-the-fly compression levels (full, compact, sparse).",
    {
      output: z.enum(["jsx", "shadcn", "vue", "svelte", "md", "html", "tailwind", "spec", "dtcg"]).optional().describe(
        "Output format: jsx, shadcn, vue, svelte, md, html, tailwind, spec (DESIGN.md), or dtcg (W3C tokens.json). Defaults to md."
      ),
      compression: z.enum(["full", "compact", "sparse"]).optional().describe(
        "Optional compression override: full (all classes), compact (fold repeated siblings, ideal for reasoning models), sparse (DOM skeleton + Vision)."
      ),
      include_metadata: z.boolean().optional().describe("Include layer name, token counts, and savings metadata. Defaults to true.")
    },
    async ({ output = "md", compression, include_metadata = true }) => {
      syncStateFromDisk();
      if (!latestContext) {
        return {
          content: [
            {
              type: "text",
              text: 'No Figma context available yet. Open TokenSqueezer in Figma, enable MCP Mode, select a frame, and click "Send to MCP".'
            }
          ]
        };
      }
      const content = resolveRequestedFormat(output, compression);
      const activeComp = compression ?? latestContext.compressionLevel;
      const items = [];
      const metaText = include_metadata ? [
        `Layer: ${latestContext.layerName}`,
        `Format: ${output.toUpperCase()} (compression: ${activeComp})`,
        `Tokens: ${latestContext.squeezedTokens} (saved ${latestContext.savedPercentage}% from ~${latestContext.rawTokens} raw)`,
        ...latestContext.imageDimensions ? [`Vision Preview: ${latestContext.imageDimensions.width}x${latestContext.imageDimensions.height}px`] : [],
        `Updated: ${new Date(latestContext.timestamp).toISOString()}`,
        `---`,
        content
      ].join("\n") : content;
      items.push({ type: "text", text: metaText });
      if (latestContext.imageDataUrl && latestContext.imageDataUrl.startsWith("data:image/")) {
        const parts = latestContext.imageDataUrl.split(",");
        const match = parts[0].match(/data:(image\/[a-zA-Z+]+);base64/);
        const mimeType = match ? match[1] : "image/png";
        const base64Data = parts[1];
        if (base64Data) {
          items.push({
            type: "image",
            data: base64Data,
            mimeType
          });
        }
      }
      return { content: items };
    }
  );
  mcp.tool(
    "get_design_spec",
    "Get the DESIGN.md specification (YAML tokens, Multi-Theme Light/Dark modes, Components, and WCAG 2.2 Accessibility Audit) for the selected Figma frame.",
    {},
    async () => {
      syncStateFromDisk();
      if (!latestContext) {
        return {
          content: [
            {
              type: "text",
              text: 'No design spec available. Select a frame in Figma and click "Send to MCP" first.'
            }
          ]
        };
      }
      const spec = resolveRequestedFormat("spec");
      return { content: [{ type: "text", text: spec || "No design spec available." }] };
    }
  );
  mcp.tool(
    "add_figma_annotation",
    "Write an AI feedback note or annotation directly back onto the selected Figma layer (attaches native Dev Mode annotation + visual AI Note card on the Figma canvas).",
    {
      annotation: z.string().describe("Feedback, review note, or implementation status to attach to the Figma layer.")
    },
    async ({ annotation }) => {
      syncStateFromDisk();
      const item = {
        id: `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        text: annotation,
        layerName: latestContext?.layerName,
        nodeId: latestContext?.nodeId ?? void 0,
        timestamp: Date.now()
      };
      await enqueueAnnotationReliable(item);
      log(`Annotation queued for Figma: "${annotation}"`);
      const health = await probeLocalDaemon(300);
      const pollTs = health?.lastPluginPollAt ?? lastPluginPollAt;
      const pluginActive = pollTs !== null && pollTs !== void 0 && Date.now() - pollTs < 2e4;
      const syncStatus = pluginActive ? "Plugin is actively polling and will apply this note to the canvas within a few seconds." : "Queued \u2014 will be applied automatically as soon as TokenSqueezer MCP Mode is connected in Figma.";
      return {
        content: [
          {
            type: "text",
            text: `Annotation queued for "${latestContext?.layerName || "current selection"}". ${syncStatus}`
          }
        ]
      };
    }
  );
  mcp.tool(
    "list_figma_components",
    "List all components, component sets, instances, and variant states in the current Figma selection tree with full hierarchy paths.",
    {},
    async () => {
      syncStateFromDisk();
      if (!latestContext) {
        return {
          content: [{ type: "text", text: "No context available. Select a frame in Figma first." }]
        };
      }
      if (latestContext.tree) {
        const found = [];
        const walk = (node, path) => {
          if (node.tag === "Comment") return;
          const nextPath = [...path, node.name];
          const isComp = node.nodeType === "COMPONENT" || node.nodeType === "COMPONENT_SET" || node.nodeType === "INSTANCE" || node.variants && node.variants.length > 0;
          if (isComp) {
            const variantDesc = node.variants && node.variants.length > 0 ? ` | Variants: ${node.variants.map((v) => `${v.property}=${v.value}`).join(", ")}` : "";
            const stateDesc = node.variantState ? ` | State: ${node.variantState}` : "";
            found.push(
              `- **${node.name}** [${node.nodeType || "INSTANCE"}] (children: ${node.children.length})${variantDesc}${stateDesc}
  Path: \`${nextPath.join(" > ")}\``
            );
          }
          for (const ch of node.children) walk(ch, nextPath);
        };
        walk(latestContext.tree, []);
        if (found.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No component instances or variants found inside "${latestContext.layerName}".`
              }
            ]
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Found ${found.length} component(s) in "${latestContext.layerName}":

${found.join("\n")}`
            }
          ]
        };
      }
      const spec = resolveRequestedFormat("spec");
      const secIdx = spec.indexOf("## Components & Variants");
      if (secIdx !== -1) {
        const nextSec = spec.indexOf("\n## ", secIdx + 5);
        return {
          content: [
            {
              type: "text",
              text: nextSec !== -1 ? spec.slice(secIdx, nextSec) : spec.slice(secIdx)
            }
          ]
        };
      }
      return { content: [{ type: "text", text: "No components found in current selection." }] };
    }
  );
  mcp.tool(
    "get_design_tokens",
    "Get design tokens from the current Figma selection in W3C Design Tokens Community Group (DTCG) JSON format, including colors, multi-theme modes, typography, spacing, shadows, and gradients.",
    {},
    async () => {
      syncStateFromDisk();
      if (!latestContext) {
        return {
          content: [
            { type: "text", text: "No design tokens available. Select a frame in Figma first." }
          ]
        };
      }
      const dtcg = resolveRequestedFormat("dtcg");
      return { content: [{ type: "text", text: dtcg || "{}" }] };
    }
  );
  mcp.tool(
    "compare_selections",
    "Compare the current Figma selection with the previous selection (token delta, node count delta, and added/removed layer names).",
    {},
    async () => {
      syncStateFromDisk();
      if (!latestContext) {
        return { content: [{ type: "text", text: "No current context. Select a frame first." }] };
      }
      if (!previousContext) {
        return {
          content: [
            {
              type: "text",
              text: `Current: "${latestContext.layerName}" (${latestContext.squeezedTokens} tokens). No previous selection recorded yet.`
            }
          ]
        };
      }
      const prevNodes = countTreeNodes(previousContext.tree);
      const currNodes = countTreeNodes(latestContext.tree);
      const prevNames = collectLayerNames(previousContext.tree);
      const currNames = collectLayerNames(latestContext.tree);
      const added = [...currNames].filter((n) => !prevNames.has(n)).slice(0, 12);
      const removed = [...prevNames].filter((n) => !currNames.has(n)).slice(0, 12);
      const lines = [
        `## Selection Comparison`,
        ``,
        `| Metric | Previous | Current |`,
        `|---|---|---|`,
        `| Layer | ${previousContext.layerName} | ${latestContext.layerName} |`,
        `| Parsed Nodes | ${prevNodes || "\u2014"} | ${currNodes || "\u2014"} |`,
        `| Raw Tokens | ~${previousContext.rawTokens} | ~${latestContext.rawTokens} |`,
        `| Squeezed Tokens | ${previousContext.squeezedTokens} | ${latestContext.squeezedTokens} |`,
        `| Saved | ${previousContext.savedPercentage}% | ${latestContext.savedPercentage}% |`,
        `| Format | ${previousContext.format} | ${latestContext.format} |`
      ];
      if (added.length > 0) lines.push(``, `**Added layers:** ${added.map((a) => `\`${a}\``).join(", ")}`);
      if (removed.length > 0) lines.push(`**Removed layers:** ${removed.map((r) => `\`${r}\``).join(", ")}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
  mcp.tool(
    "get_accessibility_report",
    "Get WCAG 2.2 sRGB relative-luminance contrast audit results for the current Figma selection.",
    {},
    async () => {
      syncStateFromDisk();
      if (!latestContext) {
        return {
          content: [
            { type: "text", text: "No accessibility data available. Select a frame in Figma first." }
          ]
        };
      }
      const spec = resolveRequestedFormat("spec");
      const match = spec.match(/^##\s*(?:⚠️\s*)?(?:Accessibility|A11y).*$/m);
      if (!match || match.index === void 0) {
        return { content: [{ type: "text", text: "No accessibility audit section found." }] };
      }
      const nextHeading = spec.indexOf("\n## ", match.index + match[0].length);
      const section = nextHeading !== -1 ? spec.slice(match.index, nextHeading) : spec.slice(match.index);
      return { content: [{ type: "text", text: section.trim() }] };
    }
  );
  mcp.tool(
    "search_layers",
    "Search layers by name, text content, or semantic type in the current Figma selection tree and return full breadcrumb paths.",
    {
      query: z.string().describe("Case-insensitive search term matched against layer names and text content."),
      type: z.enum(["text", "image", "icon", "container", "component", "all"]).optional().describe("Filter by layer category. Defaults to all.")
    },
    async ({ query, type = "all" }) => {
      syncStateFromDisk();
      if (!latestContext) {
        return { content: [{ type: "text", text: "No context available." }] };
      }
      const queryLower = query.toLowerCase();
      if (latestContext.tree) {
        const results = [];
        const matchesCategory = (n) => {
          if (type === "all") return true;
          if (type === "text") return !!n.text;
          if (type === "image") return n.tag === "img";
          if (type === "icon") return n.tag === "Icon";
          if (type === "component") {
            return n.nodeType === "COMPONENT" || n.nodeType === "COMPONENT_SET" || n.nodeType === "INSTANCE" || !!(n.variants && n.variants.length > 0);
          }
          if (type === "container") return n.children.length > 0;
          return true;
        };
        const walk = (node, ancestors) => {
          if (node.tag === "Comment") return;
          const path = [...ancestors, node.name];
          const hitName = node.name.toLowerCase().includes(queryLower);
          const hitText = node.text ? node.text.toLowerCase().includes(queryLower) : false;
          if ((hitName || hitText) && matchesCategory(node)) {
            const textPreview = node.text ? ` \u2014 "${node.text.slice(0, 50)}"` : "";
            results.push(`- \`${path.join(" > ")}\` (<${node.tag}>)${textPreview}`);
          }
          for (const ch of node.children) walk(ch, path);
        };
        walk(latestContext.tree, []);
        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No layers matching "${query}"${type !== "all" ? ` (type: ${type})` : ""} found.`
              }
            ]
          };
        }
        return {
          content: [
            { type: "text", text: `Found ${results.length} matching layer(s):

${results.join("\n")}` }
          ]
        };
      }
      const md = resolveRequestedFormat("md");
      const matches = md.split("\n").filter((line) => line.toLowerCase().includes(queryLower));
      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No layers matching "${query}" found.` }] };
      }
      return {
        content: [{ type: "text", text: `Found ${matches.length} matching lines:

${matches.join("\n")}` }]
      };
    }
  );
  mcp.registerPrompt(
    "implement_component",
    {
      title: "Implement Selected Figma Component",
      description: "Generate production-ready UI code from the current TokenSqueezer Figma selection using semantic tokens and visual preview.",
      argsSchema: {
        framework: z.enum(["jsx", "shadcn", "vue", "svelte", "tailwind", "html"]).optional().describe("Target UI framework (defaults to jsx).")
      }
    },
    async ({ framework = "jsx" }) => {
      syncStateFromDisk();
      const code = latestContext ? resolveRequestedFormat(framework, "compact") : "No Figma selection loaded yet.";
      const spec = latestContext ? resolveRequestedFormat("spec") : "";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Implement a clean, responsive, accessible ${framework.toUpperCase()} component for Figma layer "${latestContext?.layerName ?? "unknown"}".`,
                `Follow the extracted design tokens and WCAG notes below, preserve interactive states, and avoid hardcoded magic pixels where semantic flex/grid applies.`,
                ``,
                `### Design Specification`,
                spec,
                ``,
                `### Squeezed Structure (${framework.toUpperCase()})`,
                code
              ].join("\n")
            }
          }
        ]
      };
    }
  );
  mcp.registerPrompt(
    "extract_design_tokens",
    {
      title: "Extract & Map Design Tokens",
      description: "Map W3C DTCG tokens and Light/Dark variable modes from the current Figma frame into CSS variables / Tailwind theme config."
    },
    async () => {
      syncStateFromDisk();
      const dtcg = latestContext ? resolveRequestedFormat("dtcg") : "{}";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Map the following W3C DTCG design tokens from Figma layer "${latestContext?.layerName ?? "unknown"}" into our project's CSS custom properties (:root and [data-theme="dark"]) and Tailwind configuration:`,
                ``,
                "```json",
                dtcg,
                "```"
              ].join("\n")
            }
          }
        ]
      };
    }
  );
  mcp.registerPrompt(
    "audit_accessibility",
    {
      title: "Audit Figma Frame Accessibility (WCAG 2.2)",
      description: "Review color contrast, heading hierarchy, button/link semantics, and post actionable findings back to Figma."
    },
    async () => {
      syncStateFromDisk();
      const spec = latestContext ? resolveRequestedFormat("spec") : "No context loaded.";
      const md = latestContext ? resolveRequestedFormat("md") : "";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Perform a WCAG 2.2 AA accessibility audit on Figma layer "${latestContext?.layerName ?? "unknown"}".`,
                `Check contrast warnings, heading order, interactive target labeling, and missing alt descriptions. Summarize fixes and call add_figma_annotation with a concise summary for the designer.`,
                ``,
                spec,
                ``,
                `### Semantic Hierarchy`,
                md
              ].join("\n")
            }
          }
        ]
      };
    }
  );
  mcp.resource(
    "figma-context",
    "figma://current-selection",
    {
      description: "Latest squeezed Figma design output from the currently selected frame.",
      mimeType: "text/plain"
    },
    async () => {
      syncStateFromDisk();
      return {
        contents: [
          {
            uri: "figma://current-selection",
            text: latestContext?.output ?? "No context available. Select a frame in Figma.",
            mimeType: "text/plain"
          }
        ]
      };
    }
  );
  mcp.resource(
    "figma-design-tokens",
    "figma://design-tokens",
    {
      description: "W3C DTCG JSON design tokens for the current Figma selection.",
      mimeType: "application/json"
    },
    async () => {
      syncStateFromDisk();
      return {
        contents: [
          {
            uri: "figma://design-tokens",
            text: latestContext ? resolveRequestedFormat("dtcg") : "{}",
            mimeType: "application/json"
          }
        ]
      };
    }
  );
  mcp.resource(
    "figma-design-spec",
    "figma://design-spec",
    {
      description: "DESIGN.md specification + WCAG 2.2 audit for the current Figma selection.",
      mimeType: "text/markdown"
    },
    async () => {
      syncStateFromDisk();
      return {
        contents: [
          {
            uri: "figma://design-spec",
            text: latestContext ? resolveRequestedFormat("spec") : "No design spec available.",
            mimeType: "text/markdown"
          }
        ]
      };
    }
  );
  return mcp;
}
async function main() {
  if (IS_STOP) {
    const stopped = await stopLocalDaemon(600);
    process.stdout.write(
      stopped ? `Stopped TokenSqueezer HTTP bridge daemon on port ${PORT}.
` : `No running TokenSqueezer daemon found on port ${PORT}.
`
    );
    process.exit(0);
  }
  if (IS_DAEMON) {
    startHttpBridgeServer(true);
    return;
  }
  if (process.stdin.isTTY) {
    const existing = await probeLocalDaemon(350);
    if (existing?.ok) {
      await stopLocalDaemon(450);
      await sleep(140);
    }
    startHttpBridgeServer(false);
    return;
  }
  await ensureDaemonRunning();
  syncStateFromDisk(true);
  const mcp = createMcpServer();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log(`MCP stdio server v${PKG_VERSION} connected`);
}
main().catch((e) => {
  log(`Startup error: ${e}`);
});
