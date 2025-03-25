// SPDX-License-Identifier: GPL-2.0-only
// Copyright (C) 2023, Input Labs Oy.

import { AsyncSubject } from "rxjs";
import { HID } from "lib/hid";
import { timeoutPromise } from "lib/delay";
import { Profiles } from "lib/profiles";
import { delay } from "lib/delay";
import { Tunes, PresetWithValues } from "lib/tunes";
import {
  Ctrl,
  CtrlProtocolFlags,
  CtrlLog,
  CtrlProc,
  ConfigIndex,
  SectionIndex,
  PACKAGE_SIZE,
  CtrlConfigGet,
  CtrlConfigSet,
  CtrlConfigShare,
  CtrlProfileGet,
  CtrlSection,
  CtrlProfileSet,
  CtrlStatusGet,
  CtrlStatusSet,
  CtrlStatusShare,
  CtrlProfileOverwrite,
} from "lib/ctrl";

const ADDR_IN = 3;
const ADDR_OUT = 4;
const TIMEOUT = 5000;

export class Device {
  usbDevice: USBDevice;
  proxiedDevice?: Device;
  proxyEnabled: boolean = false;
  deviceVersion = [0, 0, 0];
  logs: string[] = [];
  logsProxy: string[] = [];
  isConnected = false;
  isConnectedRaw = false;
  isListening = false;
  isBusy = false;
  failed = false;
  failedError?: Error;
  pendingConfig?: AsyncSubject<CtrlConfigShare>;
  pendingProfile?: AsyncSubject<CtrlSection>;
  profiles: Profiles;
  tunes: Tunes;

  constructor(usbDevice: USBDevice) {
    this.usbDevice = usbDevice;
    this.openDevice();
    // (<any>window).device = this.device
    this.profiles = new Profiles(this);
    this.tunes = new Tunes(this);
  }

  disconnectCallback() {
    this.logs = [];
    this.isConnected = false;
    this.isConnectedRaw = false;
    this.isListening = false;
    this.deviceVersion = [0, 0, 0];
  }

  async openDevice() {
    try {
      this.failed = false;
      await this.usbDevice.open();
      console.log("Device opened");
      await this.usbDevice.selectConfiguration(1);
      console.log("Configuration selected");
      await this.usbDevice.claimInterface(1);
      console.log("Interface claimed");
      await this.sendEmpty();
      this.isConnected = true;
      this.isConnectedRaw = true;
      await this.sendStatusGet();
    } catch (error) {
      this.failed = true;
      this.failedError = error as Error;
      throw error;
    }
    this.listen();
  }

  async listen() {
    this.isListening = true;
    try {
      const response = await this.usbDevice.transferIn(ADDR_IN, PACKAGE_SIZE);
      let data = response.data as any;
      const array = new Uint8Array(data.buffer);
      const ctrl = Ctrl.decode(array);
      // console.log('Received', ctrl)
      if (ctrl instanceof CtrlLog) this.handleCtrlLog(ctrl);
      if (ctrl instanceof CtrlStatusShare) this.handleCtrlStatusShare(ctrl);
      if (ctrl instanceof CtrlConfigShare) {
        // console.log(ctrl)
        if (this.pendingConfig) {
          this.pendingConfig.next(ctrl);
          this.pendingConfig.complete();
          this.pendingConfig = undefined;
        } else {
          this.handleCtrlConfigShare(ctrl);
        }
      }
      if (ctrl instanceof CtrlSection) {
        // console.log(ctrl)
        if (this.pendingProfile) {
          this.pendingProfile.next(ctrl as CtrlSection);
          this.pendingProfile.complete();
          this.pendingProfile = undefined;
        }
      }
    } catch (error: any) {
      console.warn(error);
      return;
    }
    await this.listen();
  }

  async waitUntilReady() {
    let attempts = 0;
    while (!this.isListening || this.isBusy) {
      await delay(100);
      attempts += 1;
      if (attempts > 10) {
        if (this.isBusy) {
          throw Error("Device timeout (busy)");
        }
        break;
      }
    }
  }

  getName() {
    return this.usbDevice.productName;
  }

  getConnectorName() {
    if (this.proxyEnabled)
      return this.usbDevice.productName; // Proxy is bypassed.
    else return this.getName();
  }

  isController() {
    if (this.usbDevice.productName == "Alpakka") return true;
    return false;
  }

  isDongle() {
    return !this.isController();
  }

  isAlpakkaV0() {
    return this.usbDevice.serialNumber == "v0";
  }

  isAlpakkaV1() {
    return this.usbDevice.serialNumber == "v1";
  }

  isProxy() {
    return false;
  }

  clearLogs() {
    if (this.proxyEnabled) this.logsProxy = [];
    else this.logs = [];
  }

  handleCtrlLog(ctrl: CtrlLog) {
    let targetLogs = this.logs;
    if (ctrl.protocolFlags == CtrlProtocolFlags.WIRELESS)
      targetLogs = this.logsProxy;
    if (!targetLogs[0] || targetLogs[0]?.endsWith("\n")) {
      targetLogs.unshift(ctrl.logMessage);
    } else {
      targetLogs[0] += ctrl.logMessage;
    }
    // console.log(ctrl.logMessage)
  }

  handleCtrlStatusShare(ctrl: CtrlStatusShare) {
    this.deviceVersion = ctrl.version;
    console.log("Firmware of connected device:", this.deviceVersion);
    this.sendStatusSet();
  }

  handleCtrlConfigShare(ctrl: CtrlConfigShare) {
    // If there is no pending receiver for the config change we assume it is a
    // change made on the controller via shortcuts.
    // TODO: Investigate why the ctrl object does not return real data that
    // could be used directly (instead of nuking all data). Firmware bug?
    this.tunes.invalidatePresets();
  }

  async sendEmpty() {
    const data = new Uint8Array(64);
    await this.usbDevice.transferOut(ADDR_OUT, data);
  }

  async sendStatusGet() {
    const data = new CtrlStatusGet();
    await this.send(data);
  }

  async sendStatusSet() {
    const data = new CtrlStatusSet(Date.now());
    await this.send(data);
  }

  async sendProc(proc: HID) {
    const data = new CtrlProc(proc);
    await this.send(data);
  }

  async sendProfileOverwrite(indexTo: number, indexFrom: number) {
    const data = new CtrlProfileOverwrite(indexTo, indexFrom);
    await this.send(data);
  }

  async send(
    ctrl:
      | CtrlProc
      | CtrlStatusGet
      | CtrlStatusSet
      | CtrlConfigGet
      | CtrlProfileGet,
  ) {
    if (this.proxyEnabled) {
      ctrl.protocolFlags = CtrlProtocolFlags.WIRELESS;
    }
    // console.log(ctrl)
    await this.usbDevice.transferOut(ADDR_OUT, ctrl.encode());
  }

  async getConfig(index: ConfigIndex): Promise<PresetWithValues> {
    this.pendingConfig = new AsyncSubject();
    const ctrlOut = new CtrlConfigGet(index);
    await this.send(ctrlOut);
    const responsePromise: Promise<PresetWithValues> = new Promise(
      (resolve, reject) => {
        this.pendingConfig?.subscribe({
          next: (ctrlIn) => {
            resolve({ presetIndex: ctrlIn.preset, values: ctrlIn.values });
          },
        });
      },
    );
    const timeoutMessage = `Timeout in getConfig ${ConfigIndex[index]}`;
    const timeout = timeoutPromise(
      TIMEOUT,
      timeoutMessage,
    ) as Promise<PresetWithValues>;
    return Promise.race([responsePromise, timeout]);
  }

  async setConfig(
    index: ConfigIndex,
    preset: number,
    values: number[],
  ): Promise<number> {
    this.pendingConfig = new AsyncSubject();
    const ctrlOut = new CtrlConfigSet(index, preset, values);
    await this.send(ctrlOut);
    const responsePromise: Promise<number> = new Promise((resolve, reject) => {
      this.pendingConfig?.subscribe({
        next: (ctrlIn) => {
          resolve(ctrlIn.preset);
        },
      });
    });
    const timeoutMessage = `Timeout in setConfig ${ConfigIndex[index]}`;
    const timeout = timeoutPromise(TIMEOUT, timeoutMessage) as Promise<number>;
    return Promise.race([responsePromise, timeout]);
  }

  async getSection(
    profileIndex: number,
    sectionIndex: SectionIndex,
  ): Promise<CtrlSection> {
    await this.waitUntilReady();
    this.isBusy = true;
    this.pendingProfile = new AsyncSubject();
    const ctrlOut = new CtrlProfileGet(profileIndex, sectionIndex);
    await this.send(ctrlOut).catch((error) => {
      this.isBusy = false;
      throw error;
    });
    const responsePromise: Promise<CtrlSection> = new Promise(
      (resolve, reject) => {
        this.pendingProfile?.subscribe({
          next: (ctrlIn) => {
            resolve(ctrlIn);
          },
        });
      },
    );
    const timeoutMessage = `Timeout in getSection ${SectionIndex[sectionIndex]}`;
    const timeout = timeoutPromise(
      TIMEOUT,
      timeoutMessage,
    ) as Promise<CtrlSection>;
    return Promise.race([responsePromise, timeout]).finally(() => {
      this.isBusy = false;
    });
  }

  async setSection(profileIndex: number, section: CtrlSection) {
    this.pendingProfile = new AsyncSubject();
    const ctrlOut = new CtrlProfileSet(
      profileIndex,
      section.sectionIndex,
      section.payload(),
    );
    await this.send(ctrlOut);
    const responsePromise = new Promise((resolve, reject) => {
      this.pendingProfile?.subscribe({
        next: (ctrlIn) => {
          resolve(ctrlIn);
        },
      });
    });
    const timeoutMessage = `Timeout in setSection`;
    const timeout = timeoutPromise(TIMEOUT, timeoutMessage);
    return Promise.race([responsePromise, timeout]);
  }
}

// Fake wireless device connected to dongle.
// The WebUSB underlying operations are controlled by the dongle device,
// but some properties are overridden via proxy.
export const deviceWirelessProxyHandler = {
  get(target: Device, property: keyof Device) {
    const key = String(property);
    if (key == "getName") return () => "Alpakka";
    if (key == "logs") return target.logsProxy;
    if (key == "isController") return () => true;
    if (key == "isDongle") return () => false;
    if (key == "isAlpakkaV0") return () => false;
    if (key == "isAlpakkaV1") return () => true;
    if (key == "isProxy") return () => true;
    return target[property];
  },
};
