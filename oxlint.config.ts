import { defineConfig } from "oxlint";
import base from "@browsercore/dev/oxlint";
export default defineConfig({
    extends: [base],
    rules: {
        "no-underscore-dangle": ["error", { allow: ["_state", "_establish"] }],
    },
});
