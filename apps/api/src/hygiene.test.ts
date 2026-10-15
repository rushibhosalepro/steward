import { expect, test } from "bun:test";
import { Glob } from "bun";

// A regex written through a shell or Python string can silently turn "\b" into a backspace
// byte; the pattern then never matches and nothing errors. This caught it twice.
test("no control characters in source files", async () => {
  const bad: string[] = [];
  for (const root of ["src", "../web/src"]) {
    for await (const file of new Glob("**/*.{ts,tsx,css}").scan(root)) {
      const text = await Bun.file(`${root}/${file}`).text();
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) bad.push(`${root}/${file}`);
    }
  }
  expect(bad).toEqual([]);
});
