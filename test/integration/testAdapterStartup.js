"use strict";

const path = require("node:path");
const { tests } = require("@iobroker/testing");

tests.integration(path.join(__dirname, "..", ".."), {
    defineAdditionalTests({ suite }) {
        suite("adapter startup", getHarness => {
            it("starts with default configuration", async function () {
                this.timeout(60000);
                const harness = getHarness();
                await harness.startAdapterAndWait();
            });
        });
    },
});
