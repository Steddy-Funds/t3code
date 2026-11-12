import { createCodeIntelEnvironmentAtoms } from "@t3tools/client-runtime/state/code-intel";

import { connectionAtomRuntime } from "../connection/runtime";

export const codeIntelEnvironment = createCodeIntelEnvironmentAtoms(connectionAtomRuntime);
