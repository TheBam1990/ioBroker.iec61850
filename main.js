"use strict";

const net = require("node:net");
const utils = require("@iobroker/adapter-core");

const SERVICE = {
    MMS: "mms",
    REPORTS: "reports",
    GOOSE: "goose",
    SAMPLED_VALUES: "sampled-values",
};

function asArray(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return value
                .split(",")
                .map(item => item.trim())
                .filter(Boolean);
        }
    }
    return [];
}

function stateIdPart(value, fallback) {
    const raw = String(value || fallback || "item").trim();
    return raw.replace(/[.\s]+/g, "_").replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 80) || "item";
}

function valueType(type) {
    if (type === "boolean" || type === "number" || type === "string") {
        return type;
    }
    return "mixed";
}

class Iec61850Adapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "iec61850",
        });

        this.client = null;
        this.server = null;
        this.reconnectTimer = null;
        this.statusTimer = null;
        this.bytesRx = 0;
        this.bytesTx = 0;
        this.clientConnected = false;
        this.serverConnections = new Set();

        this.on("ready", () => this.onReady());
        this.on("stateChange", (id, state) => this.onStateChange(id, state));
        this.on("unload", callback => this.onUnload(callback));
    }

    get services() {
        const services = new Set(asArray(this.config.services));
        if (this.config.serviceMms !== false) {
            services.add(SERVICE.MMS);
        }
        if (this.config.serviceReports !== false) {
            services.add(SERVICE.REPORTS);
        }
        if (this.config.serviceGoose === true) {
            services.add(SERVICE.GOOSE);
        }
        if (this.config.serviceSampledValues === true) {
            services.add(SERVICE.SAMPLED_VALUES);
        }
        return services;
    }

    get role() {
        return ["client", "server", "both"].includes(this.config.role) ? this.config.role : "client";
    }

    async onReady() {
        await this.createConfiguredObjects();
        await this.setState("info.connection", false, true);
        await this.setState("info.mode", this.role, true);
        await this.setState("info.services", [...this.services].join(","), true);
        await this.setState("diagnostics.status", "starting", true);
        await this.setState("diagnostics.lastError", "", true);
        await this.setState("diagnostics.bytesRx", 0, true);
        await this.setState("diagnostics.bytesTx", 0, true);

        this.subscribeStates("points.*.set");

        if (!this.config.enabled) {
            await this.setState("diagnostics.status", "disabled", true);
            this.log.info("IEC 61850 adapter is disabled in the instance configuration.");
            return;
        }

        this.startStatusTimer();

        if (this.services.has(SERVICE.MMS)) {
            if (this.role === "client" || this.role === "both") {
                this.startMmsClient();
            }
            if (this.role === "server" || this.role === "both") {
                this.startMmsServer();
            }
        }

        if (this.services.has(SERVICE.REPORTS)) {
            await this.setState("reports.status", "configured", true);
        }

        if (this.services.has(SERVICE.GOOSE)) {
            await this.startRawEthernetService("goose", this.config.gooseInterface, this.config.gooseAppId);
        }

        if (this.services.has(SERVICE.SAMPLED_VALUES)) {
            await this.startRawEthernetService(
                "sampledValues",
                this.config.sampledValuesInterface,
                this.config.sampledValuesAppId,
            );
        }

        await this.updateConnectionState();
    }

    async createConfiguredObjects() {
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: { name: "Information" },
            native: {},
        });
        await this.setObjectNotExistsAsync("diagnostics", {
            type: "channel",
            common: { name: "Diagnostics" },
            native: {},
        });
        await this.setObjectNotExistsAsync("reports", {
            type: "channel",
            common: { name: "Reports" },
            native: {},
        });
        await this.setObjectNotExistsAsync("points", {
            type: "channel",
            common: { name: "Data points" },
            native: {},
        });
        await this.setObjectNotExistsAsync("goose", {
            type: "channel",
            common: { name: "GOOSE" },
            native: {},
        });
        await this.setObjectNotExistsAsync("sampledValues", {
            type: "channel",
            common: { name: "Sampled Values" },
            native: {},
        });
        await this.setObjectNotExistsAsync("mms", {
            type: "channel",
            common: { name: "MMS" },
            native: {},
        });

        await this.ensureState("info.connection", "Connected", "boolean", "indicator.connected");
        await this.ensureState("info.mode", "Mode", "string", "state");
        await this.ensureState("info.services", "Services", "string", "state");
        await this.ensureState("diagnostics.status", "Status", "string", "state");
        await this.ensureState("diagnostics.lastError", "Last error", "string", "state");
        await this.ensureState("diagnostics.bytesRx", "Bytes received", "number", "state", "byte");
        await this.ensureState("diagnostics.bytesTx", "Bytes transmitted", "number", "state", "byte");
        await this.ensureState("diagnostics.lastFrameHex", "Last frame hex", "string", "state");
        await this.ensureState("mms.clientConnected", "MMS client connected", "boolean", "indicator.connected");
        await this.ensureState("mms.serverConnections", "MMS server connections", "number", "value");
        await this.ensureState("reports.status", "Report status", "string", "state");
        await this.ensureState("goose.status", "GOOSE status", "string", "state");
        await this.ensureState("sampledValues.status", "Sampled Values status", "string", "state");

        const reports = asArray(this.config.reports);
        for (const [index, report] of reports.entries()) {
            const id = stateIdPart(report.id || report.reference || report.name, `report_${index + 1}`);
            await this.setObjectNotExistsAsync(`reports.${id}`, {
                type: "channel",
                common: { name: report.name || report.reference || id },
                native: { reference: report.reference || "", enabled: report.enabled !== false },
            });
            await this.ensureState(`reports.${id}.enabled`, "Enabled", "boolean", "switch");
            await this.ensureState(`reports.${id}.reference`, "Object reference", "string", "state");
            await this.ensureState(`reports.${id}.lastUpdate`, "Last update", "string", "state");
            await this.ensureState(`reports.${id}.value`, "Last value", "mixed", "state");
            await this.setState(`reports.${id}.enabled`, report.enabled !== false, true);
            await this.setState(`reports.${id}.reference`, report.reference || "", true);
        }

        const points = asArray(this.config.points);
        for (const [index, point] of points.entries()) {
            const id = stateIdPart(point.id || point.reference || point.name, `point_${index + 1}`);
            await this.setObjectNotExistsAsync(`points.${id}`, {
                type: "channel",
                common: { name: point.name || point.reference || id },
                native: { reference: point.reference || "", write: !!point.write },
            });
            await this.ensureState(`points.${id}.value`, point.name || id, valueType(point.type), "state");
            await this.ensureState(`points.${id}.reference`, "IEC 61850 reference", "string", "state");
            await this.ensureState(`points.${id}.quality`, "Quality", "string", "state");
            await this.ensureState(`points.${id}.timestamp`, "Timestamp", "string", "state");
            await this.setState(`points.${id}.reference`, point.reference || "", true);
            await this.setState(`points.${id}.quality`, "not-connected", true);
            if (point.write) {
                await this.ensureState(`points.${id}.set`, `${point.name || id} set value`, valueType(point.type), "state");
            }
        }
    }

    async ensureState(id, name, type, role, unit) {
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: {
                name,
                type,
                role,
                read: true,
                write: role === "switch" || id.endsWith(".set"),
                unit,
            },
            native: {},
        });
    }

    startMmsClient() {
        this.clearReconnectTimer();
        const host = String(this.config.mmsHost || "").trim();
        const port = Number(this.config.mmsPort) || 102;

        if (!host) {
            this.setError("MMS client host is empty.");
            return;
        }

        this.log.info(`Connecting IEC 61850 MMS TCP client to ${host}:${port}`);
        const socket = net.createConnection({ host, port });
        this.client = socket;
        socket.setTimeout(Number(this.config.connectTimeoutMs) || 10000);

        socket.on("connect", async () => {
            this.clientConnected = true;
            socket.setTimeout(0);
            this.log.info(`IEC 61850 MMS TCP client connected to ${host}:${port}`);
            await this.setState("mms.clientConnected", true, true);
            await this.setState("diagnostics.status", "mms-client-connected", true);
            await this.updateConnectionState();
        });

        socket.on("data", data => this.handleMmsData(data, "client"));
        socket.on("timeout", () => socket.destroy(new Error("MMS client connection timeout")));
        socket.on("error", error => this.setError(`MMS client error: ${error.message}`));
        socket.on("close", async () => {
            if (this.client === socket) {
                this.client = null;
            }
            this.clientConnected = false;
            await this.setState("mms.clientConnected", false, true);
            await this.updateConnectionState();
            this.scheduleReconnect();
        });
    }

    startMmsServer() {
        const bind = String(this.config.mmsBind || "0.0.0.0").trim();
        const port = Number(this.config.mmsServerPort) || 8102;
        this.server = net.createServer(socket => this.handleServerConnection(socket));
        this.server.on("error", error => this.setError(`MMS server error: ${error.message}`));
        this.server.listen(port, bind, async () => {
            this.log.info(`IEC 61850 MMS TCP server listening on ${bind}:${port}`);
            await this.setState("diagnostics.status", "mms-server-listening", true);
            await this.updateConnectionState();
        });
    }

    handleServerConnection(socket) {
        const label = `${socket.remoteAddress || "unknown"}:${socket.remotePort || 0}`;
        this.serverConnections.add(socket);
        this.log.info(`IEC 61850 MMS TCP server connection from ${label}`);
        this.setState("mms.serverConnections", this.serverConnections.size, true).catch(error =>
            this.log.warn(`Could not update server connection count: ${error.message}`),
        );
        this.updateConnectionState().catch(error => this.log.warn(`Could not update connection state: ${error.message}`));

        socket.on("data", data => this.handleMmsData(data, "server"));
        socket.on("error", error => this.log.warn(`MMS server socket error from ${label}: ${error.message}`));
        socket.on("close", () => {
            this.serverConnections.delete(socket);
            this.setState("mms.serverConnections", this.serverConnections.size, true).catch(error =>
                this.log.warn(`Could not update server connection count: ${error.message}`),
            );
            this.updateConnectionState().catch(error =>
                this.log.warn(`Could not update connection state: ${error.message}`),
            );
        });
    }

    async handleMmsData(data, source) {
        this.bytesRx += data.length;
        await this.setState("diagnostics.bytesRx", this.bytesRx, true);
        await this.setState("diagnostics.lastFrameHex", data.toString("hex").slice(0, 512), true);
        await this.setState("diagnostics.status", `mms-${source}-frame-received`, true);
        this.log.debug(`IEC 61850 MMS ${source} frame: ${data.toString("hex")}`);
    }

    async startRawEthernetService(service, iface, appId) {
        const label = service === "goose" ? "GOOSE" : "Sampled Values";
        const stateRoot = service === "goose" ? "goose" : "sampledValues";
        const message = `${label} needs raw Ethernet access and a native IEC 61850 backend; configured interface=${iface || "not set"}, appId=${appId || "not set"}`;
        this.log.warn(message);
        await this.setState(`${stateRoot}.status`, message, true);
    }

    scheduleReconnect() {
        if (!this.config.enabled || !this.services.has(SERVICE.MMS) || !(this.role === "client" || this.role === "both")) {
            return;
        }
        this.clearReconnectTimer();
        const delay = Number(this.config.reconnectDelayMs) || 10000;
        this.reconnectTimer = setTimeout(() => this.startMmsClient(), delay);
    }

    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    startStatusTimer() {
        const interval = Math.max(1000, Number(this.config.pollIntervalMs) || 30000);
        this.statusTimer = setInterval(() => {
            this.updateConnectionState().catch(error => this.log.warn(`Could not update status: ${error.message}`));
        }, interval);
    }

    async updateConnectionState() {
        const connected =
            this.clientConnected ||
            this.serverConnections.size > 0 ||
            (!!this.server && (this.role === "server" || this.role === "both"));
        await this.setState("info.connection", connected, true);
        await this.setState("mms.clientConnected", this.clientConnected, true);
        await this.setState("mms.serverConnections", this.serverConnections.size, true);
    }

    async setError(message) {
        this.log.warn(message);
        await this.setState("diagnostics.lastError", message, true);
        await this.setState("diagnostics.status", "error", true);
        await this.updateConnectionState();
    }

    async onStateChange(id, state) {
        if (!state || state.ack || !id.endsWith(".set")) {
            return;
        }
        const localId = id.replace(`${this.namespace}.`, "");
        const valueId = localId.replace(/\.set$/, ".value");
        await this.setState(valueId, state.val, true);
        await this.setState(localId, state.val, true);
        await this.setState(valueId.replace(/\.value$/, ".timestamp"), new Date().toISOString(), true);
        await this.setState(valueId.replace(/\.value$/, ".quality"), "local-write-buffered", true);
        this.log.info(`Buffered IEC 61850 write for ${valueId}: ${state.val}`);
    }

    onUnload(callback) {
        try {
            this.clearReconnectTimer();
            if (this.statusTimer) {
                clearInterval(this.statusTimer);
                this.statusTimer = null;
            }
            if (this.client) {
                this.client.destroy();
                this.client = null;
            }
            for (const socket of this.serverConnections) {
                socket.destroy();
            }
            this.serverConnections.clear();
            if (this.server) {
                this.server.close();
                this.server = null;
            }
            callback();
        } catch (error) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Iec61850Adapter(options);
} else {
    new Iec61850Adapter();
}
