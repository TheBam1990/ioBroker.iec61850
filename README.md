# ioBroker IEC 61850

ioBroker adapter for IEC 61850 communication with selectable client/server mode, MMS TCP diagnostics, report data points, GOOSE raw Ethernet capture/publish and Sampled Values raw Ethernet capture/publish.

German documentation is available here: [README.de.md](README.de.md).

## Current scope

This test version is built to install cleanly in ioBroker and provide a structured IEC 61850 adapter base. It contains:

- Client, server or combined role selection.
- Native MMS client connection with automatic model browsing and cyclic dataset polling.
- MMS TCP server listener for lab tests, default port `8102`.
- Report Control Block configuration and ioBroker report states.
- Automatic and manual IEC 61850 data point mapping.
- GOOSE and Sampled Values raw Ethernet receive support through `tcpdump`.
- GOOSE and Sampled Values raw frame publishing through a raw socket helper.

The bundled native MMS backend discovers logical nodes, datasets, report control blocks and dataset members. Discovered values are created automatically below `mms.data` and refreshed with the configured polling interval.

## Requirements

- ioBroker with js-controller 6 or newer.
- Node.js 22 or newer.
- For MMS client mode: TCP access to the IED or gateway.
- For real MMS server mode on TCP `102`: permission to bind privileged ports, or use a test port such as `8102`.
- For GOOSE and Sampled Values receive: Linux host with `tcpdump` installed and permission to capture on the selected interface.
- For GOOSE and Sampled Values publish: `python3` and raw socket permission, usually root or `CAP_NET_RAW`.

## Configuration

### General

Set `Enable adapter` only after the target settings are correct. Select:

- `Client`: connect to an IEC 61850 MMS server.
- `Server`: listen locally for MMS TCP clients.
- `Client + Server`: do both at the same time.

Select services:

- `MMS`: TCP-based Manufacturing Message Specification transport.
- `Reports`: Report Control Block state model.
- `GOOSE`: raw Ethernet event messages.
- `Sampled Values`: raw Ethernet sampled measurement streams.

### MMS

For client mode:

- `MMS server host`: IP address or DNS name of the IED.
- `MMS server port`: normally `102`.
- `Connect timeout ms`: connection timeout.
- `Reconnect delay ms`: delay before reconnect.

For server mode:

- `Server bind address`: local bind IP, usually `0.0.0.0`.
- `Local server port`: `8102` for tests or `102` for real MMS if the host permits it.

### Reports

Each report entry creates states below:

```text
iec61850.0.reports.<id>.enabled
iec61850.0.reports.<id>.reference
iec61850.0.reports.<id>.lastUpdate
iec61850.0.reports.<id>.value
```

Example report reference:

```text
IED1LD0/LLN0.RP.Events
```

### Data points

With automatic MMS browsing enabled, discovered values are created below:

```text
iec61850.0.mms.data.<logical-device>.<logical-node>.<data-object>.<attribute>
```

The states `mms.logicalNodes`, `mms.datasets`, `mms.dataPoints` and `mms.modelStatus` show the discovery result.

Manual data points create states below:

```text
iec61850.0.points.<id>.value
iec61850.0.points.<id>.reference
iec61850.0.points.<id>.quality
iec61850.0.points.<id>.timestamp
```

Writable points also get:

```text
iec61850.0.points.<id>.set
```

Writes are buffered into the ioBroker value state in this first version. A later MMS backend can use the same state to send real IEC 61850 writes.

### GOOSE and Sampled Values

GOOSE and Sampled Values do not use TCP/IP sockets. They use Ethernet frames directly. For this reason a pure JavaScript adapter cannot fully implement them without native raw Ethernet access.

This adapter uses `tcpdump` for receiving raw Ethernet frames:

- GOOSE EtherType: `0x88b8`
- Sampled Values EtherType: `0x88ba`

Configure the Linux network interface, for example `eth0`, and optionally an AppID filter. The AppID value is interpreted as hexadecimal, for example `1000` or `4000`.

Received frames are exposed below:

```text
iec61850.0.goose.status
iec61850.0.goose.captureActive
iec61850.0.goose.frameCount
iec61850.0.goose.lastAppId
iec61850.0.goose.lastSourceMac
iec61850.0.goose.lastDestinationMac
iec61850.0.goose.lastPayloadHex
iec61850.0.goose.lastFrameHex
iec61850.0.goose.lastTimestamp
iec61850.0.sampledValues.status
iec61850.0.sampledValues.captureActive
iec61850.0.sampledValues.frameCount
iec61850.0.sampledValues.lastAppId
iec61850.0.sampledValues.lastSourceMac
iec61850.0.sampledValues.lastDestinationMac
iec61850.0.sampledValues.lastPayloadHex
iec61850.0.sampledValues.lastFrameHex
iec61850.0.sampledValues.lastTimestamp
```

Raw publishing is intentionally disabled by default. To send a frame:

1. Enable `Allow GOOSE raw publishing` or `Allow Sampled Values raw publishing`.
2. Write a complete Ethernet frame as hex string to:

```text
iec61850.0.goose.publishFrameHex
iec61850.0.sampledValues.publishFrameHex
```

The hex string must include destination MAC, source MAC, optional VLAN tag, EtherType, APPID, length, reserved fields and the IEC 61850 payload.

## States

Important diagnostic states:

```text
iec61850.0.info.connection
iec61850.0.info.mode
iec61850.0.info.services
iec61850.0.diagnostics.status
iec61850.0.diagnostics.lastError
iec61850.0.diagnostics.bytesRx
iec61850.0.diagnostics.bytesTx
iec61850.0.diagnostics.lastFrameHex
iec61850.0.mms.clientConnected
iec61850.0.mms.serverConnections
```

## Troubleshooting

### Client does not connect

- Check the IED IP address.
- Check TCP port `102`.
- Check firewall rules between ioBroker and the IED.
- Some substations restrict MMS clients by IP address.

### Server mode does not start on port 102

TCP ports below `1024` are privileged on Linux. Use port `8102` for tests or grant the needed capability to the Node.js runtime on the target host.

### GOOSE or Sampled Values do not capture frames

- Install `tcpdump`.
- Check the interface name, for example `ip link`.
- Start ioBroker with permission to run packet capture, or grant the required capability to `tcpdump`.
- Make sure the switch port receives the multicast frames. Some managed switches need multicast or mirror configuration.

### Raw publishing fails

- Check that publishing is enabled in the adapter configuration.
- Check that `python3` is installed.
- Check that the ioBroker process has raw socket permission.
- Verify that the frame contains the correct EtherType: `0x88b8` for GOOSE or `0x88ba` for Sampled Values.

## Changelog

### 0.3.4

- Fix startup of the native MMS connection API.

### 0.3.3

- Run the thread-based native MMS backend in a dedicated adapter process.

### 0.3.2

- Build the bundled native MMS backend reliably during ioBroker installation and updates.

### 0.3.1

- Load the locally compiled MMS backend directly on ioBroker installations.

### 0.3.0

- Add native MMS associations and automatic data-model browsing.
- Create discovered dataset members automatically as ioBroker states.
- Poll dataset values cyclically and expose discovered report control blocks.

### 0.2.1

- Initialize GOOSE and Sampled Values states even when the adapter function is disabled.

### 0.2.0

- Add raw Ethernet receive support for GOOSE and Sampled Values.
- Add parsed raw frame header states and payload hex states.
- Add raw frame publishing through writeable `publishFrameHex` states.

### 0.1.2

- Replace service multiselect with Admin-compatible service checkboxes.

### 0.1.1

- Create info and diagnostic objects before writing startup states.

### 0.1.0

- Initial installable IEC 61850 adapter foundation.
- Add client/server role selection.
- Add MMS TCP client and test server diagnostics.
- Add reports and manual data point state model.
- Add guarded GOOSE and Sampled Values configuration.

## License

MIT

Copyright (c) 2026 TheBam1990
