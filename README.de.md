# ioBroker IEC 61850

ioBroker-Adapter fuer IEC 61850 mit umschaltbarem Client-/Server-Modus, MMS-TCP-Diagnose, Report-Datenpunkten, GOOSE-Raw-Ethernet-Empfang/Senden und Sampled-Values-Raw-Ethernet-Empfang/Senden.

Englische Dokumentation: [README.md](README.md).

## Aktueller Umfang

Diese Testversion ist so gebaut, dass sie sauber in ioBroker installiert werden kann und eine strukturierte IEC-61850-Basis bereitstellt. Enthalten sind:

- Auswahl als Client, Server oder Client + Server.
- MMS-TCP-Client-Verbindung zu einem IEC-61850-Geraet, normalerweise TCP-Port `102`.
- MMS-TCP-Server fuer Labortests, Standard-Port `8102`.
- Konfiguration von Report Control Blocks und ioBroker-Report-Zustaenden.
- Manuelle IEC-61850-Datenpunktzuordnung.
- GOOSE- und Sampled-Values-Raw-Ethernet-Empfang ueber `tcpdump`.
- GOOSE- und Sampled-Values-Raw-Frame-Senden ueber einen Raw-Socket-Helfer.

Vollstaendiges IEC-61850-MMS-Browsing und ASN.1-Decoding aller MMS-/GOOSE-/SV-Payloads benoetigen weiterhin ein natives IEC-61850-Backend wie libIEC61850 oder eine gleichwertige Systemkomponente. Der Adapter empfaengt und sendet aber bereits echte Ethernet-Frames fuer GOOSE und Sampled Values und stellt den geparsten IEC-61850-Frame-Header sowie die Payload als Hex-Wert in ioBroker bereit.

## Anforderungen

- ioBroker mit js-controller 6 oder neuer.
- Node.js 22 oder neuer.
- Fuer MMS-Clientbetrieb: TCP-Zugriff auf das IED oder Gateway.
- Fuer echten MMS-Serverbetrieb auf TCP `102`: Berechtigung fuer privilegierte Ports, alternativ Test-Port `8102`.
- Fuer GOOSE- und Sampled-Values-Empfang: Linux-Host mit installiertem `tcpdump` und Berechtigung zum Mitschneiden auf dem ausgewaehlten Interface.
- Fuer GOOSE- und Sampled-Values-Senden: `python3` und Raw-Socket-Berechtigung, normalerweise root oder `CAP_NET_RAW`.

## Konfiguration

### Allgemein

`Adapter aktivieren` erst einschalten, wenn die Zielwerte passen. Rolle auswaehlen:

- `Client`: verbindet sich zu einem IEC-61850-MMS-Server.
- `Server`: lauscht lokal auf MMS-TCP-Clients.
- `Client + Server`: beides gleichzeitig.

Dienste:

- `MMS`: TCP-basierter Manufacturing Message Specification Transport.
- `Reports`: Zustandsmodell fuer Report Control Blocks.
- `GOOSE`: Raw-Ethernet-Ereignistelegramme.
- `Sampled Values`: Raw-Ethernet-Messwertstroeme.

### MMS

Fuer Client-Modus:

- `MMS-Server Host`: IP-Adresse oder DNS-Name des IED.
- `MMS-Server Port`: normalerweise `102`.
- `Verbindungs-Timeout ms`: Timeout fuer den Verbindungsaufbau.
- `Reconnect-Verzoegerung ms`: Wartezeit bis zum erneuten Verbinden.

Fuer Server-Modus:

- `Server Bind-Adresse`: lokale IP, meistens `0.0.0.0`.
- `Lokaler Server-Port`: `8102` fuer Tests oder `102`, wenn der Host das erlaubt.

### Reports

Jeder Report-Eintrag erzeugt Zustaende unter:

```text
iec61850.0.reports.<id>.enabled
iec61850.0.reports.<id>.reference
iec61850.0.reports.<id>.lastUpdate
iec61850.0.reports.<id>.value
```

Beispiel fuer eine Report-Referenz:

```text
IED1LD0/LLN0.RP.Events
```

### Datenpunkte

Manuelle Datenpunkte erzeugen Zustaende unter:

```text
iec61850.0.points.<id>.value
iec61850.0.points.<id>.reference
iec61850.0.points.<id>.quality
iec61850.0.points.<id>.timestamp
```

Schreibbare Punkte bekommen zusaetzlich:

```text
iec61850.0.points.<id>.set
```

Schreibwerte werden in dieser ersten Version lokal in den ioBroker-Wert uebernommen. Ein spaeteres MMS-Backend kann denselben Zustand fuer echte IEC-61850-Schreibbefehle verwenden.

### GOOSE und Sampled Values

GOOSE und Sampled Values laufen nicht ueber normale TCP/IP-Sockets. Sie nutzen Ethernet-Frames direkt. Deshalb kann ein reiner JavaScript-Adapter diese Dienste ohne nativen Raw-Ethernet-Zugriff nicht vollstaendig implementieren.

Der Adapter nutzt `tcpdump`, um Raw-Ethernet-Frames zu empfangen:

- GOOSE EtherType: `0x88b8`
- Sampled Values EtherType: `0x88ba`

Konfiguriere das Linux-Netzwerkinterface, zum Beispiel `eth0`, und optional einen AppID-Filter. Der AppID-Wert wird als Hex-Wert interpretiert, zum Beispiel `1000` oder `4000`.

Empfangene Frames werden hier abgelegt:

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

Raw-Senden ist absichtlich standardmaessig deaktiviert. Zum Senden:

1. `GOOSE Raw-Senden erlauben` oder `Sampled Values Raw-Senden erlauben` aktivieren.
2. Einen vollstaendigen Ethernet-Frame als Hex-String in einen dieser States schreiben:

```text
iec61850.0.goose.publishFrameHex
iec61850.0.sampledValues.publishFrameHex
```

Der Hex-String muss Ziel-MAC, Quell-MAC, optional VLAN-Tag, EtherType, APPID, Length, Reserved-Felder und IEC-61850-Payload enthalten.

## Wichtige Zustaende

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

## Fehlersuche

### Client verbindet sich nicht

- IP-Adresse des IED pruefen.
- TCP-Port `102` pruefen.
- Firewall zwischen ioBroker und IED pruefen.
- Manche Anlagen erlauben MMS nur von freigegebenen Client-IP-Adressen.

### Server startet nicht auf Port 102

TCP-Ports unter `1024` sind unter Linux privilegiert. Fuer Tests Port `8102` nutzen oder dem Node.js-Prozess die passende Berechtigung geben.

### GOOSE oder Sampled Values empfangen keine Frames

- `tcpdump` installieren.
- Interface-Namen pruefen, zum Beispiel mit `ip link`.
- ioBroker mit Berechtigung fuer Packet-Capture starten oder `tcpdump` die passende Capability geben.
- Pruefen, ob der Switch-Port die Multicast-Frames ueberhaupt sieht. Bei Managed Switches ist oft Multicast- oder Mirror-Konfiguration noetig.

### Raw-Senden schlaegt fehl

- Pruefen, ob Senden in der Adapterkonfiguration erlaubt ist.
- Pruefen, ob `python3` installiert ist.
- Pruefen, ob der ioBroker-Prozess Raw-Socket-Berechtigung hat.
- Pruefen, ob der Frame den richtigen EtherType enthaelt: `0x88b8` fuer GOOSE oder `0x88ba` fuer Sampled Values.

## Changelog

### 0.3.4

- Start der nativen MMS-Verbindungs-API korrigiert.

### 0.3.3

- Threadbasiertes natives MMS-Backend in einem eigenen Adapterprozess ausführen.

### 0.3.2

- Gebündeltes natives MMS-Backend bei ioBroker-Installation und Updates zuverlässig bauen.

### 0.3.1

- Lokal kompiliertes MMS-Backend in ioBroker-Installationen direkt laden.

### 0.3.0

- Native MMS-Verbindungen und automatisches Datenmodell-Browsing ergänzt.
- Gefundene Dataset-Mitglieder automatisch als ioBroker-States angelegt.
- Zyklische Dataset-Abfrage und Anzeige gefundener Report Control Blocks ergänzt.

### 0.2.1

- GOOSE- und Sampled-Values-States werden auch bei deaktivierter Adapterfunktion initialisiert.

### 0.2.0

- Raw-Ethernet-Empfang fuer GOOSE und Sampled Values ergaenzt.
- Geparste Raw-Frame-Header-States und Payload-Hex-States ergaenzt.
- Raw-Frame-Senden ueber schreibbare `publishFrameHex`-States ergaenzt.

### 0.1.2

- Dienst-Mehrfachauswahl durch Admin-kompatible Dienst-Checkboxen ersetzt.

### 0.1.1

- Info- und Diagnoseobjekte werden vor dem Schreiben der Startzustaende angelegt.

### 0.1.0

- Erste installierbare IEC-61850-Adaptergrundlage.
- Client-/Server-Rollenumschaltung.
- MMS-TCP-Client und Testserver-Diagnose.
- Reports und manuelles Datenpunktmodell.
- Abgesicherte GOOSE- und Sampled-Values-Konfiguration.

## Lizenz

MIT

Copyright (c) 2026 TheBam1990
