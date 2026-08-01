import { resolve } from "node:path";
import { FirestoreStateStore, LocalStateStore, type StateStore } from "./state-store.ts";

export function createStateStoreFromEnvironment(): StateStore {
  const backend = (process.env.AR_STATE_BACKEND ?? "local").trim().toLowerCase();
  if (backend === "local") {
    return new LocalStateStore(resolve(process.env.AR_LOCAL_STATE_DIR ?? ".state"));
  }
  if (backend === "firestore") {
    return new FirestoreStateStore(undefined, process.env.AR_FIRESTORE_PREFIX ?? "arttra");
  }
  throw new Error(`AR_STATE_BACKENDはlocalまたはfirestoreを指定してください: ${backend}`);
}
