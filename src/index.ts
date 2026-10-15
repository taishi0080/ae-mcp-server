#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runJsx } from "./bridge.js";

const server = new McpServer({ name: "ae-mcp-server", version: "0.1.0" });

// ---- shared schema fragments -------------------------------------------------
const compRef = z
  .union([z.string(), z.number()])
  .optional()
  .describe("Composition name or id. Omit to use the active composition.");
const layerRef = z
  .union([z.string(), z.number()])
  .describe("Layer name, or 1-based layer index.");
const color = z
  .array(z.number().min(0).max(1))
  .length(3)
  .describe("RGB color, each channel 0-1, e.g. [1, 0.5, 0].");
const point2 = z.array(z.number()).length(2);

// ---- helper to register a tool backed by an ExtendScript body ----------------
function ok(result: unknown) {
  const text = result === undefined ? "OK" : JSON.stringify(result, null, 2);
  return { content: [{ type: "text" as const, text }] };
}
function fail(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function jsxTool(
  name: string,
  title: string,
  description: string,
  shape: z.ZodRawShape,
  body: string,
  options: { undo?: boolean; timeoutMs?: number } = {},
): void {
  const handler = async (args: Record<string, unknown>) => {
    try {
      const result = await runJsx(body, args, {
        undoName: options.undo === false ? undefined : `MCP: ${title}`,
        timeoutMs: options.timeoutMs,
      });
      return ok(result);
    } catch (e) {
      return fail(e);
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool(name, { title, description, inputSchema: shape }, handler as any);
}

// ---- tools -------------------------------------------------------------------

jsxTool(
  "ae_get_project_info",
  "Get project info",
  "Return the current After Effects version, project file path, and a list of all project items.",
  {},
  `
  var items = [];
  for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      items.push({ id: it.id, name: it.name, type: __itemType(it) });
  }
  var active = app.project.activeItem;
  return {
      aeVersion: app.version,
      projectPath: app.project.file ? app.project.file.fsName : null,
      numItems: app.project.numItems,
      activeItem: active ? active.name : null,
      items: items
  };`,
  { undo: false },
);

jsxTool(
  "ae_list_compositions",
  "List compositions",
  "List all compositions in the project with size, duration and frame rate.",
  {},
  `
  var comps = [];
  for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (it instanceof CompItem) {
          comps.push({
              id: it.id, name: it.name, width: it.width, height: it.height,
              pixelAspect: it.pixelAspect, duration: it.duration,
              frameRate: it.frameRate, numLayers: it.numLayers
          });
      }
  }
  return comps;`,
  { undo: false },
);

jsxTool(
  "ae_create_composition",
  "Create composition",
  "Create a new composition and make it the active item in the viewer.",
  {
    name: z.string().describe("Composition name."),
    width: z.number().int().min(4).max(30000).default(1920),
    height: z.number().int().min(4).max(30000).default(1080),
    pixelAspect: z.number().default(1),
    duration: z.number().positive().default(10).describe("Duration in seconds."),
    frameRate: z.number().positive().default(30),
  },
  `
  var comp = app.project.items.addComp(
      args.name, args.width || 1920, args.height || 1080,
      args.pixelAspect || 1, args.duration || 10, args.frameRate || 30
  );
  comp.openInViewer();
  return { id: comp.id, name: comp.name, width: comp.width, height: comp.height,
           duration: comp.duration, frameRate: comp.frameRate };`,
);

jsxTool(
  "ae_list_layers",
  "List layers",
  "List the layers of a composition.",
  { comp: compRef },
  `
  var comp = __findComp(args.comp);
  var layers = [];
  for (var i = 1; i <= comp.numLayers; i++) layers.push(__layerInfo(comp.layer(i)));
  return { comp: comp.name, layers: layers };`,
  { undo: false },
);

jsxTool(
  "ae_add_text_layer",
  "Add text layer",
  "Add a text layer to a composition.",
  {
    comp: compRef,
    text: z.string().describe("Text content."),
    name: z.string().optional().describe("Layer name (defaults to the text)."),
    fontSize: z.number().positive().optional(),
    font: z.string().optional().describe("PostScript font name, e.g. 'ArialMT'."),
    fillColor: color.optional(),
    position: point2.optional().describe("[x, y] in pixels. Defaults to comp center."),
  },
  `
  var comp = __findComp(args.comp);
  var layer = comp.layers.addText(args.text);
  if (args.name) layer.name = args.name;
  var prop = layer.property("ADBE Text Properties").property("ADBE Text Document");
  var td = prop.value;
  if (args.fontSize) td.fontSize = args.fontSize;
  if (args.font) td.font = args.font;
  if (args.fillColor) { td.applyFill = true; td.fillColor = args.fillColor; }
  prop.setValue(td);
  if (args.position) layer.property("ADBE Transform Group").property("ADBE Position").setValue(args.position);
  else layer.property("ADBE Transform Group").property("ADBE Position").setValue([comp.width / 2, comp.height / 2]);
  return __layerInfo(layer);`,
);

jsxTool(
  "ae_add_solid_layer",
  "Add solid layer",
  "Add a solid layer to a composition. Defaults to the full composition size.",
  {
    comp: compRef,
    name: z.string().default("Solid"),
    color: color.default([1, 1, 1]),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  },
  `
  var comp = __findComp(args.comp);
  var layer = comp.layers.addSolid(
      args.color || [1, 1, 1], args.name || "Solid",
      args.width || comp.width, args.height || comp.height, comp.pixelAspect, comp.duration
  );
  return __layerInfo(layer);`,
);

jsxTool(
  "ae_add_shape_layer",
  "Add shape layer",
  "Add a shape layer containing a filled rectangle or ellipse.",
  {
    comp: compRef,
    shape: z.enum(["rectangle", "ellipse"]).default("rectangle"),
    name: z.string().optional(),
    size: point2.default([200, 200]).describe("[width, height] in pixels."),
    fillColor: color.default([1, 1, 1]),
    position: point2.optional().describe("[x, y] in pixels. Defaults to comp center."),
  },
  `
  var comp = __findComp(args.comp);
  var isEllipse = args.shape === "ellipse";
  var layer = comp.layers.addShape();
  layer.name = args.name || (isEllipse ? "Ellipse" : "Rectangle");
  var root = layer.property("ADBE Root Vectors Group");
  var group = root.addProperty("ADBE Vector Group");
  var inner = group.property("ADBE Vectors Group");
  var shape = inner.addProperty(isEllipse ? "ADBE Vector Shape - Ellipse" : "ADBE Vector Shape - Rect");
  shape.property(isEllipse ? "ADBE Vector Ellipse Size" : "ADBE Vector Rect Size").setValue(args.size || [200, 200]);
  var fill = inner.addProperty("ADBE Vector Graphic - Fill");
  fill.property("ADBE Vector Fill Color").setValue(args.fillColor || [1, 1, 1]);
  var pos = args.position || [comp.width / 2, comp.height / 2];
  layer.property("ADBE Transform Group").property("ADBE Position").setValue(pos);
  return __layerInfo(layer);`,
);

jsxTool(
  "ae_set_layer_transform",
  "Set layer transform",
  "Set transform properties of a layer. If 'time' is given, keyframes are set at that time (seconds) instead of static values.",
  {
    comp: compRef,
    layer: layerRef,
    position: z.array(z.number()).min(2).max(3).optional(),
    anchorPoint: z.array(z.number()).min(2).max(3).optional(),
    scale: z.array(z.number()).min(2).max(3).optional().describe("Percent, e.g. [100, 100]."),
    rotation: z.number().optional().describe("Degrees."),
    opacity: z.number().min(0).max(100).optional(),
    time: z.number().min(0).optional().describe("Time in seconds; creates a keyframe."),
  },
  `
  var comp = __findComp(args.comp);
  var layer = __findLayer(comp, args.layer);
  var tg = layer.property("ADBE Transform Group");
  var map = {
      position: "ADBE Position", anchorPoint: "ADBE Anchor Point", scale: "ADBE Scale",
      rotation: "ADBE Rotate Z", opacity: "ADBE Opacity"
  };
  var changed = [];
  for (var key in map) {
      if (!map.hasOwnProperty(key)) continue;
      if (args[key] === undefined || args[key] === null) continue;
      var p = tg.property(map[key]);
      if (typeof args.time === "number") p.setValueAtTime(args.time, args[key]);
      else p.setValue(args[key]);
      changed.push(key);
  }
  return { layer: layer.name, changed: changed };`,
);

jsxTool(
  "ae_add_effect",
  "Add effect",
  "Add an effect to a layer by match name (e.g. 'ADBE Gaussian Blur 2') and optionally set its properties by name or index.",
  {
    comp: compRef,
    layer: layerRef,
    effectMatchName: z.string().describe("Effect match name, e.g. 'ADBE Gaussian Blur 2'."),
    properties: z
      .record(z.union([z.number(), z.string(), z.array(z.number())]))
      .optional()
      .describe("Map of effect property name (or index as string) to value."),
  },
  `
  var comp = __findComp(args.comp);
  var layer = __findLayer(comp, args.layer);
  var effect = layer.property("ADBE Effect Parade").addProperty(args.effectMatchName);
  var set = [];
  if (args.properties) {
      for (var k in args.properties) {
          if (!args.properties.hasOwnProperty(k)) continue;
          var key = /^[0-9]+$/.test(k) ? parseInt(k, 10) : k;
          effect.property(key).setValue(args.properties[k]);
          set.push(k);
      }
  }
  return { layer: layer.name, effect: effect.name, propertiesSet: set };`,
);

jsxTool(
  "ae_import_file",
  "Import file",
  "Import a footage/image/audio file into the project, optionally adding it to a composition as a layer.",
  {
    path: z.string().describe("Absolute path to the file on the machine running After Effects."),
    addToComp: z.boolean().default(false),
    comp: compRef,
  },
  `
  var f = new File(args.path);
  if (!f.exists) throw new Error("File not found: " + args.path);
  var io = new ImportOptions(f);
  var item = app.project.importFile(io);
  var result = { id: item.id, name: item.name };
  if (args.addToComp) {
      var comp = __findComp(args.comp);
      var layer = comp.layers.add(item);
      result.layer = __layerInfo(layer);
  }
  return result;`,
);

jsxTool(
  "ae_render",
  "Render composition",
  "Add a composition to the render queue and optionally render it. Blocks until rendering finishes.",
  {
    comp: compRef,
    outputPath: z.string().describe("Absolute output file path."),
    renderSettingsTemplate: z.string().optional().describe("e.g. 'Best Settings'."),
    outputModuleTemplate: z.string().optional().describe("e.g. 'Lossless', 'H.264 - Match Render Settings - 15 Mbps' (if available)."),
    render: z.boolean().default(true).describe("false = only queue the item."),
    timeoutMs: z.number().int().positive().optional().describe("Max wait in ms (default 1 hour for render)."),
  },
  `
  var comp = __findComp(args.comp);
  var rq = app.project.renderQueue;
  var item = rq.items.add(comp);
  if (args.renderSettingsTemplate) item.applyTemplate(args.renderSettingsTemplate);
  var om = item.outputModule(1);
  if (args.outputModuleTemplate) om.applyTemplate(args.outputModuleTemplate);
  om.file = new File(args.outputPath);
  var rendered = false;
  if (args.render !== false) {
      rq.render();
      rendered = true;
  }
  return { queued: true, rendered: rendered, output: om.file.fsName };`,
  { timeoutMs: 3_600_000 },
);

jsxTool(
  "ae_save_project",
  "Save project",
  "Save the current project. Provide 'path' to Save As (.aep).",
  { path: z.string().optional().describe("Absolute .aep path for Save As.") },
  `
  if (args.path) app.project.save(new File(args.path));
  else app.project.save();
  return { path: app.project.file ? app.project.file.fsName : null };`,
  { undo: false },
);

// Escape hatch: arbitrary ExtendScript.
server.registerTool(
  "ae_run_jsx",
  {
    title: "Run ExtendScript",
    description:
      "Run arbitrary ExtendScript (ES3) inside After Effects. The code is the BODY of a function: " +
      "use `return` to send a JSON-serializable value back, and read inputs from `args`. " +
      "Helpers available: __findComp(ref), __findLayer(comp, ref), __layerInfo(layer). " +
      "Example: return app.project.numItems;",
    inputSchema: {
      code: z.string().describe("ExtendScript function body."),
      args: z.record(z.unknown()).optional().describe("Value exposed to the script as `args`."),
      timeoutMs: z.number().int().positive().optional(),
    },
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (async (input: { code: string; args?: Record<string, unknown>; timeoutMs?: number }) => {
    try {
      const result = await runJsx(input.code, input.args ?? {}, {
        undoName: "MCP: Run ExtendScript",
        timeoutMs: input.timeoutMs,
      });
      return ok(result);
    } catch (e) {
      return fail(e);
    }
  }) as any,
);

// ---- start -------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ae-mcp-server running on stdio");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
