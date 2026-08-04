import { defineConfig } from "oxlint";
import base from "@browsercore/dev/oxlint";
export default defineConfig({
    extends: [base],
    rules: {
        // `_state` and `_establish` are Transport's internal field/method
        // prefixes (EventEmitter subclass state + private lifecycle hook).
        "no-underscore-dangle": ["error", { allow: ["_state", "_establish"] }],
    },
});
