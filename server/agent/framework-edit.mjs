import { constants } from "node:fs";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { frameworkStatePath } from "./snapshot.mjs";

export function createFrameworkEditTool(root, getActiveTurn) {
  const edit = createEditToolDefinition(root);
  return {
    ...edit,
    async execute(id, args, signal, onUpdate, context) {
      const turn = getActiveTurn();
      if (!turn || !frameworkStatePath({ root }, args?.path)) {
        return edit.execute(id, args, signal, onUpdate, context);
      }

      let content;
      const capturingEdit = createEditToolDefinition(root, { operations: {
        access: file => access(file, constants.R_OK | constants.W_OK),
        readFile,
        async writeFile(file, value) {
          await writeFile(file, value, "utf8");
          const realRoot = await realpath(root).catch(() => null);
          const destination = await realpath(file).catch(() => null);
          if (realRoot && destination?.startsWith(realRoot + path.sep)) content = value;
        },
      } });
      const result = await capturingEdit.execute(id, args, signal, onUpdate, context);
      // Pi supplied the complete content written under its file mutation lock.
      if (content !== undefined && !result.isError) {
        (turn.frameworkEdits ??= new Map()).set(id, content);
      }
      return result;
    },
  };
}
