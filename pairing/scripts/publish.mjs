import { rename as move } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Windows scanners may briefly retain a freshly verified executable/directory.
// Never delete either payload, and do not retry permanent/path errors.
export async function publishReplacement(
  output,
  destination,
  previous,
  {
    rename: movePayload = move,
    platform = process.platform,
    pause = delay,
  } = {},
) {
  async function rename(from, to) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await movePayload(from, to);
      } catch (error) {
        if (
          platform !== "win32" ||
          !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
          attempt >= 19
        )
          throw error;
        await pause(Math.min(25 * 2 ** attempt, 250));
      }
    }
  }
  await rename(destination, previous);
  try {
    await rename(output, destination);
  } catch (error) {
    try {
      await rename(previous, destination);
    } catch (rollback) {
      throw new AggregateError(
        [error, rollback],
        `Publication and rollback failed; payloads preserved at ${previous} and ${output}`,
      );
    }
    throw error;
  }
}
