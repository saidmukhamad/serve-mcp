// Imported first so it runs before node:sqlite loads and emits its warning.
const defaults = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  for (const listener of defaults) listener(warning);
});
