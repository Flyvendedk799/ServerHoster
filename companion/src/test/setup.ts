import { afterEach, beforeEach } from "vitest";

// The vault reads localStorage at module load, so every test needs a clean
// slate before the module under test is imported.
beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});
