import type { ReviewRequestReadModel } from "./review-types.ts";
import { createStateStoreFromEnvironment } from "./state-store-factory.ts";

const reference = process.argv[2]?.trim() ?? "";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(reference)) {
  throw new Error(
    "owner/repository#PR番号を指定してください。例: mise run slack:review -- art-tra/repo#123",
  );
}
const model = await createStateStoreFromEnvironment().get<ReviewRequestReadModel>(
  "review-read-model",
  reference,
);
if (!model) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, found: false, reference })}\n`);
  process.exitCode = 2;
} else {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, found: true, review: model }, null, 2)}\n`,
  );
}
