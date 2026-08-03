import { lookup as nodeLookup } from "node:dns";
import { abortReason } from "./errors.js";
import { isPublicAddress, type PublicTarget } from "./target.js";
import { WebError } from "./errors.js";

export type AddressAnswer = { address: string; family: number };
export type Resolver = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly AddressAnswer[]>;

export const resolvePublicTarget = async (
  target: PublicTarget,
  signal: AbortSignal,
  resolver: Resolver = lookup,
): Promise<PublicTarget> => {
  if (signal.aborted) {
    throw abortReason(signal);
  }
  if (target.isLiteral) {
    return target;
  }
  let answers: readonly AddressAnswer[];
  try {
    answers = await resolver(target.hostname, signal);
  } catch (error) {
    if (signal.aborted) {
      throw abortReason(signal);
    }
    if (error instanceof WebError) {
      throw error;
    }
    throw new WebError("dns", "Web Fetch could not resolve the public target.");
  }
  if (signal.aborted) {
    throw abortReason(signal);
  }
  if (
    answers.length === 0 ||
    answers.some(
      (answer) =>
        !isPublicAddress(answer.address) ||
        (answer.family !== 4 && answer.family !== 6) ||
        (answer.family === 4
          ? answer.address.includes(":")
          : !answer.address.includes(":")),
    )
  ) {
    throw new WebError(
      "target",
      "Web Fetch target resolution was not entirely public.",
    );
  }
  return target;
};

export function lookup(
  hostname: string,
  signal: AbortSignal,
): Promise<AddressAnswer[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (!settled) {
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      }
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    nodeLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      finish(() => {
        if (error) {
          reject(error);
          return;
        }
        resolve(addresses);
      });
    });
  });
}
