'use strict';

import { sleep, float_to_str, dec2hex, dec2hex32, lerp_color, initAnalyticsApi, la, createCookie, readCookie } from './utils.js';
import { initControllerManager } from './controller-manager.js';
import ControllerFactory from './controllers/controller-factory.js';
import { lang_init, l } from './translations.js';
import { loadAllTemplates } from './template-loader.js';
import { draw_stick_position, CIRCULARITY_DATA_SIZE } from './stick-renderer.js';
import { ds5_finetune, isFinetuneVisible, finetune_handle_controller_input } from './modals/finetune-modal.js';
import { calibrate_stick_centers, auto_calibrate_stick_centers } from './modals/calib-center-modal.js';
import { calibrate_range } from './modals/calib-range-modal.js';
import { show_input_analysis_modal, toggle_input_analysis, stop_input_analysis, isInputAnalysisVisible, input_analysis_handle_input } from './modals/input-analysis-modal.js';


// Application State - manages app-wide state and UI
const app = {
  // Button disable state management
  disable_btn: 0,
  last_disable_btn: 0,

  shownRangeCalibrationWarning: false,

  // Language and UI state
  lang_orig_text: {},
  lang_cur: {},
  lang_disabled: true,
  lang_cur_direction: "ltr",

  // Session tracking
  gj: 0,
  gu: 0,
  
  // Android Bridge Flag
  isAndroid: false
};

const ll_data = new Array(CIRCULARITY_DATA_SIZE);
const rr_data = new Array(CIRCULARITY_DATA_SIZE);

let controller = null;

// Cache for frequently accessed DOM elements to improve performance
const domCache = {
  lx_lbl: null,
  ly_lbl: null,
  rx_lbl: null,
  ry_lbl: null,
  stickCanvas: null,
  l2_progress: null,
  r2_progress: null
};

function gboot() {
  app.gu = crypto.randomUUID();

  // Detect Android WebView Interface
  if (window.AndroidBridge) {
      app.isAndroid = true;
      console.log("Android Bridge Detected");
  }

  async function initializeApp() {
    // Cache DOM elements after DOM is loaded
    domCache.lx_lbl = document.getElementById("lx-lbl");
    domCache.ly_lbl = document.getElementById("ly-lbl");
    domCache.rx_lbl = document.getElementById("rx-lbl");
    domCache.ry_lbl = document.getElementById("ry-lbl");
    domCache.stickCanvas = document.getElementById("stickCanvas");
    domCache.l2_progress = document.getElementById("l2-progress");
    domCache.r2_progress = document.getElementById("r2-progress");

    window.addEventListener("error", (event) => {
      console.error(event.error?.stack || event.message);
      show_popup(event.error?.message || event.message);
    });

    window.addEventListener("unhandledrejection", async (event) => {
      console.error("Unhandled rejection:", event.reason?.stack || event.reason);
      close_all_modals();

      let errorMessage = "An unexpected error occurred";
      if (event.reason) {
        if (event.reason.message) {
          errorMessage = `<strong>Error:</strong> ${event.reason.message}`;
        } else if (typeof event.reason === 'string') {
          errorMessage = `<strong>Error:</strong> ${event.reason}`;
        }
        let allStackTraces = '';
        if (event.reason.stack) {
          const stackTrace = event.reason.stack.replace(/\n/g, '<br>').replace(/ /g, '&nbsp;');
          allStackTraces += `<strong>Main Error Stack:</strong><br>${stackTrace}`;
        }
        if (allStackTraces) {
          errorMessage += `
            <br>
            <details style="margin-top: 0px;">
              <summary style="cursor: pointer; color: #666;">Details</summary>
              <div style="font-family: monospace; font-size: 0.85em; margin-top: 8px; padding: 8px; background-color: #f8f9fa; border-radius: 4px; overflow-x: auto;">
                ${allStackTraces}
              </div>
            </details>
          `;
        }
      }
      errorAlert(errorMessage);
      event.preventDefault();
    });

    await loadAllTemplates();

    initAnalyticsApi(app);
    lang_init(app, handleLanguageChange, show_welcome_modal);

    document.querySelectorAll("input[name='displayMode']").forEach(el => {
        el.addEventListener('change', on_stick_mode_change);
    });

    const edgeModalCheckbox = document.getElementById('edgeModalDontShowAgain');
    if (edgeModalCheckbox) {
        edgeModalCheckbox.addEventListener('change', function() {
            localStorage.setItem('edgeModalDontShowAgain', this.checked.toString());
        });
    }
    
    const colorPicker = document.getElementById('ledColorPicker');
    if (colorPicker) {
        colorPicker.addEventListener('input', function() {
            const hex = this.value;
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            
            if (controller && controller.currentController) {
                controller.currentController.setLightbarColor(r, g, b);
            }
        });
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initializeApp);
  } else {
    initializeApp();
  }

  if (!("hid" in navigator) && !app.isAndroid) {
    setDisplay('offlinebar', false);
    setDisplay('onlinebar', false);
    setDisplay('missinghid', true);
    return;
  }

  setDisplay('offlinebar', true);
  if (!app.isAndroid) {
      navigator.hid.addEventListener("disconnect", handleDisconnectedDevice);
  }
}

function setDisplay(id, show) {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? 'block' : 'none';
}

function toggleElement(id, show) {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
}

// Helper to reset connect button UI state
function resetConnectUI() {
    const btnConnect = document.getElementById("btnconnect");
    const connectSpinner = document.getElementById("connectspinner");
    if (btnConnect) btnConnect.disabled = false;
    if (connectSpinner) connectSpinner.style.display = 'none';
}

async function connect() {
  app.gj = crypto.randomUUID();
  initAnalyticsApi(app); 

  controller = initControllerManager({ handleNvStatusUpdate });
  controller.setInputHandler(handleControllerInput);

  la("begin");
  reset_circularity_mode();
  clearAllAlerts();
  await sleep(200);

  const btnConnect = document.getElementById("btnconnect");
  const connectSpinner = document.getElementById("connectspinner");
  
  btnConnect.disabled = true;
  connectSpinner.style.display = 'inline-block';
  await sleep(100);

  try {
    if (app.isAndroid) {
        window.AndroidBridge.requestUsbPermission();
    } else {
        const supportedModels = ControllerFactory.getSupportedModels();
        const requestParams = { filters: supportedModels };
        let devices = await navigator.hid.getDevices();
        if (devices.length == 0) {
          devices = await navigator.hid.requestDevice(requestParams);
        }
        if (devices.length == 0) {
          throw new Error("No device selected");
        }

        if (devices.length > 1) {
          infoAlert(l("Please connect only one controller at time."));
          throw new Error("Multiple devices connected");
        }

        const [device] = devices;
        if(device.opened) {
          console.log("Device already opened, closing it before re-opening.");
          await device.close();
          await sleep(500);
        }
        await device.open();

        la("connect", {"p": device.productId, "v": device.vendorId});
        device.oninputreport = continue_connection; 
        await setupDeviceUI(device);
    }

  } catch(error) {
    console.error("Connection failed", error);
    resetConnectUI();
    await disconnect();
  }
}

// --- Android Specific Callbacks ---

// Called when user grants permission and connection is ready
window.onAndroidDeviceConnected = async function(deviceParams) {
    console.log("Android Device Connected:", deviceParams);
    
    const virtualDevice = {
        vendorId: deviceParams.vendorId,
        productId: deviceParams.productId,
        productName: deviceParams.productName || "Android Device",
        opened: true,
        oninputreport: null, 

        sendFeatureReport: async (reportId, data) => {
            const hexData = [...data].map(b => b.toString(16).padStart(2,'0')).join('');
            await window.AndroidBridge.sendFeatureReport(reportId, hexData);
        },

        receiveFeatureReport: async (reportId) => {
            const responseHex = await window.AndroidBridge.receiveFeatureReport(reportId);
            const pairs = responseHex.match(/[\w\d]{2}/g) || [];
            let buffer = new Uint8Array(pairs.map(h => parseInt(h, 16)));

            // *** SMART FIX FOR CLONE ISSUE ***
            // Force strip first byte if it matches Report ID
            if (buffer.length > 0 && buffer[0] === reportId) {
                console.log(`[Fix] Stripping Report ID (${reportId})`);
                buffer = buffer.slice(1);
            }

            return new DataView(buffer.buffer);
        },

        sendReport: async (reportId, data) => {
             const hexData = [...data].map(b => b.toString(16).padStart(2,'0')).join('');
             await window.AndroidBridge.sendOutputReport(reportId, hexData);
        },

        close: async () => {
            await window.AndroidBridge.closeDevice();
        }
    };

    la("connect", {"p": virtualDevice.productId, "v": virtualDevice.vendorId});
    
    try {
        await setupDeviceUI(virtualDevice);
    } catch (e) {
        console.error("Android Setup Error", e);
        resetConnectUI();
        await disconnect();
    }
};

// Called if connection fails (e.g. no device found or permission denied)
window.onAndroidConnectFailed = function() {
    console.log("Android Connection Failed");
    resetConnectUI();
};

window.onAndroidInputReport = function(reportId, dataHex) {
    if (controller && controller.currentController) {
        const handler = controller.currentController.device.oninputreport;
        if (handler) {
            const pairs = dataHex.match(/[\w\d]{2}/g) || [];
            const buffer = new Uint8Array(pairs.map(h => parseInt(h, 16))).buffer;
            const dataView = new DataView(buffer);
            handler({ data: dataView, device: controller.currentController.device, reportId: reportId });
        }
    }
};

window.onAndroidDeviceDetached = async function() {
    await disconnect();
};
// ----------------------------------

async function setupDeviceUI(device) {
    if (!controller) {
         controller = initControllerManager({ handleNvStatusUpdate });
         controller.setInputHandler(handleControllerInput);
    }
    
    function applyDeviceUI({ showInfo, showFinetune, showInfoTab, showFourStepCalib, showQuickCalib }) {
      toggleElement("infoshowall", showInfo);
      toggleElement("ds5finetune", showFinetune);
      toggleElement("info-tab", showInfoTab);
      toggleElement("four-step-center-calib", showFourStepCalib);
      toggleElement("quick-center-calib", showQuickCalib);
    }

    let controllerInstance = null;
    let info = null;

    try {
      controllerInstance = ControllerFactory.createControllerInstance(device);
      controller.setControllerInstance(controllerInstance);

      info = await controllerInstance.getInfo();

      if (controllerInstance.initializeCurrentOutputState) {
        await controllerInstance.initializeCurrentOutputState();
      }
    } catch (error) {
      const contextMessage = device 
        ? `${l("Connected invalid device")}: ${dec2hex(device.vendorId)}:${dec2hex(device.productId)}`
        : l("Failed to connect to device");
        throw new Error(contextMessage, { cause: error });
    }

    if(!info?.ok) {
      if(info) console.error(JSON.stringify(info, null, 2));
      throw new Error(`${l("Connected invalid device")}: ${l("Error")}  1`, { cause: info?.error });
    }

    const ui = ControllerFactory.getUIConfig(device.productId);
    applyDeviceUI(ui);

    console.log("Setting input report handler.");
    device.oninputreport = controller.getInputHandler();

    const deviceName = ControllerFactory.getDeviceName(device.productId);
    document.getElementById("devname").textContent = deviceName + " (" + dec2hex(device.vendorId) + ":" + dec2hex(device.productId) + ")";

    setDisplay("offlinebar", false);
    setDisplay("onlinebar", true);
    setDisplay("mainmenu", true);
    toggleElement("resetBtn", true);

    const nvStatusEl = document.getElementById("d-nvstatus");
    if(nvStatusEl) nvStatusEl.textContent = l("Unknown");
    
    const triggerEl = document.querySelector('#controller-tab');
    if(triggerEl) bootstrap.Tab.getOrCreateInstance(triggerEl).show();

    const model = controllerInstance.getModel();

    await init_svg_controller(model);

    initialize_button_indicators(controller.getInputConfig().buttonMap);

    if (model == "DS5_Edge" && info?.pending_reboot) {
      infoAlert(l("A reboot is needed to continue using this DualSense Edge. Please disconnect and reconnect your controller."));
      await disconnect();
      return;
    }

    render_info_to_dom(info.infoItems);

    if (info.nv) {
      render_nvstatus_to_dom(info.nv);
      if (info.nv.locked === false) {
        await nvslock();
      }
    }

    if (typeof info.disable_bits === 'number' && info.disable_bits) {
      app.disable_btn |= info.disable_bits;
    }
    if(app.disable_btn != 0) update_disable_btn();

    if (model == "DS4" && info?.rare) {
      show_popup("Wow, this is a rare/weird controller! Please write me an email at ds4@the.al or contact me on Discord (the_al)");
    }

    if(model == "DS5_Edge") {
      show_edge_modal();
    }
    
    // Successful connection -> Stop spinner
    resetConnectUI();
}

async function continue_connection(event) {
    if (!controller || controller.isConnected()) return; 
}

async function disconnect() {
  la("disconnect");
  if(!controller?.isConnected()) {
    controller = null;
    // Ensure UI is reset even if already disconnected logic
    resetConnectUI();
    return;
  }
  app.gj = 0;
  app.disable_btn = 0;
  update_disable_btn();

  await controller.disconnect();
  controller = null;
  close_all_modals();
  setDisplay("offlinebar", true);
  setDisplay("onlinebar", false);
  setDisplay("mainmenu", false);
  
  // Reset connect button state on disconnect
  resetConnectUI();
}

function disconnectSync() {
  disconnect().catch(error => {
    throw new Error("Failed to disconnect", { cause: error });
  });
}

async function handleDisconnectedDevice(e) {
  la("disconnected");
  console.log("Disconnected: " + e.device.productName)
  await disconnect();
}

function render_nvstatus_to_dom(nv) {
  if(!nv?.status) {
    throw new Error("Invalid NVS status data", { cause: nv?.error });
  }

  const el = document.getElementById("d-nvstatus");
  if(!el) return;

  switch (nv.status) {
    case 'locked':
      el.innerHTML = "<font color='green'>" + l("locked") + "</font>";
      break;
    case 'unlocked':
      el.innerHTML = "<font color='red'>" + l("unlocked") + "</font>";
      break;
    case 'pending_reboot':
      const pendingTxt = nv.raw !== undefined ? ("0x" + dec2hex32(nv.raw)) : String(nv.code ?? '');
      el.innerHTML = "<font color='purple'>unk " + pendingTxt + "</font>";
      break;
    case 'unknown':
      const unknownTxt = nv.device === 'ds5' && nv.raw !== undefined ? ("0x" + dec2hex32(nv.raw)) : String(nv.code ?? '');
      el.innerHTML = "<font color='purple'>unk " + unknownTxt + "</font>";
      break;
    case 'error':
      el.innerHTML = "<font color='red'>" + l("error") + "</font>";
      break;
  }
}

async function refresh_nvstatus() {
  if (!controller.isConnected()) {
    return null;
  }

  return await controller.queryNvStatus();
}

function set_edge_progress(score) {
  const el = document.getElementById("dsedge-progress");
  if(el) el.style.width = score + "%";
}

function show_welcome_modal() {
  return;
}
 
async function init_svg_controller(model) {
  const svgContainer = document.getElementById('controller-svg-placeholder');
  if(!svgContainer) return;

  let svgFileName = (model === 'DS4') ? 'dualshock-controller.svg' : 'dualsense-controller.svg';

  try {
      // محاولة تحميل الصورة
      let svgContent;
      if (window.BUNDLED_ASSETS && window.BUNDLED_ASSETS.svg && window.BUNDLED_ASSETS.svg[svgFileName]) {
        svgContent = window.BUNDLED_ASSETS.svg[svgFileName];
      } else {
        const response = await fetch(`assets/${svgFileName}`);
        if (!response.ok) throw new Error("SVG Not Found");
        svgContent = await response.text();
      }
      svgContainer.innerHTML = svgContent;
      
      // تلوين الصورة
      const lightBlue = '#7ecbff';
      const midBlue = '#3399cc';
      const dualshock = document.getElementById('Controller');
      set_svg_group_color(dualshock, lightBlue);
      ['Button_outlines', 'Button_outlines_behind', 'L3_outline', 'R3_outline', 'Trackpad_outline'].forEach(id => {
        const group = document.getElementById(id);
        set_svg_group_color(group, midBlue);
      });
      
  } catch (e) {
      console.warn("Could not load controller image, continuing without it.", e);
      // لا نوقف التنفيذ، بل نكمل ليظهر باقي الواجهة
      svgContainer.innerHTML = "<p style='color:white; text-align:center;'>Controller Image Not Loaded</p>";
  }
}

function collectCircularityData(stickStates, leftData, rightData) {
  const { left, right  } = stickStates || {};
  const MAX_N = CIRCULARITY_DATA_SIZE;

  for(const [stick, data] of [[left, leftData], [right, rightData]]) {
    if (!stick) return;

    const { x, y } = stick;
    const distance = Math.sqrt(x * x + y * y);
    const angleIndex = (parseInt(Math.round(Math.atan2(y, x) * MAX_N / 2.0 / Math.PI)) + MAX_N) % MAX_N;
    const oldValue = data[angleIndex] ?? 0;
    data[angleIndex] = Math.max(oldValue, distance);
  }
}

function clear_circularity() {
  ll_data.fill(0);
  rr_data.fill(0);
}

function reset_circularity_mode() {
  clear_circularity();
  const normalMode = document.getElementById("normalMode");
  if(normalMode) normalMode.checked = true;
  refresh_stick_pos();
}

function refresh_stick_pos() {
  if(!controller) return;

  const c = domCache.stickCanvas;
  if(!c) return;
  
  const ctx = c.getContext("2d");
  const sz = 60;
  const hb = 20 + sz;
  const yb = 15 + sz;
  const w = c.width;
  ctx.clearRect(0, 0, c.width, c.height);

  const { left: { x: plx, y: ply }, right: { x: prx, y: pry } } = controller.button_states.sticks;

  const enable_zoom_center = center_zoom_checked();
  const enable_circ_test = circ_checked();
  
  // Draw left stick
  draw_stick_position(ctx, hb, yb, sz, plx, ply, {
    circularity_data: enable_circ_test ? ll_data : null,
    enable_zoom_center,
  });

  // Draw right stick
  draw_stick_position(ctx, w-hb, yb, sz, prx, pry, {
    circularity_data: enable_circ_test ? rr_data : null,
    enable_zoom_center,
  });

  const precision = enable_zoom_center ? 3 : 2;
  
  if(domCache.lx_lbl) domCache.lx_lbl.textContent = float_to_str(plx, precision);
  if(domCache.ly_lbl) domCache.ly_lbl.textContent = float_to_str(ply, precision);
  if(domCache.rx_lbl) domCache.rx_lbl.textContent = float_to_str(prx, precision);
  if(domCache.ry_lbl) domCache.ry_lbl.textContent = float_to_str(pry, precision);

  // Move L3 and R3 SVG elements according to stick position
  try {
    const model = controller.getModel();
    let l3_x, l3_y, r3_x, r3_y;
    let transform_l, transform_r;

    if (model === "DS4") {
        const max_offset = 25;
        const l3_cx = 295.63, l3_cy = 461.03;
        const r3_cx = 662.06, r3_cy = 419.78;

        l3_x = l3_cx + plx * max_offset;
        l3_y = l3_cy + ply * max_offset;
        r3_x = r3_cx + prx * max_offset;
        r3_y = r3_cy + pry * max_offset;

        transform_l = `translate(${l3_x - l3_cx},${l3_y - l3_cy})`;
        transform_r = `translate(${r3_x - r3_cx},${r3_y - r3_cy})`;

    } else if (model === "DS5" || model === "DS5_Edge") {
        const max_offset = 25;
        const l3_cx = 295.63, l3_cy = 461.03;
        const r3_cx = 662.06, r3_cy = 419.78;

        l3_x = l3_cx + plx * max_offset;
        l3_y = l3_cy + ply * max_offset;
        r3_x = r3_cx + prx * max_offset;
        r3_y = r3_cy + pry * max_offset;

        transform_l = `translate(${l3_x - l3_cx},${l3_y - l3_cy}) scale(0.70)`;
        transform_r = `translate(${r3_x - r3_cx},${r3_y - r3_cy}) scale(0.70)`;
    }

    if (transform_l) {
        const l3_group = document.querySelector('g#L3');
        if (l3_group) l3_group.setAttribute('transform', transform_l);
        
        const r3_group = document.querySelector('g#R3');
        if (r3_group) r3_group.setAttribute('transform', transform_r);
    }
  } catch (e) {
    // Fail silently if SVG not present
  }
}

const circ_checked = () => document.getElementById("checkCircularityMode")?.checked;
const center_zoom_checked = () => document.getElementById("centerZoomMode")?.checked;

function resetStickDiagrams() {
  clear_circularity();
  refresh_stick_pos();
}

function switchTo10xZoomMode() {
  const el = document.getElementById("centerZoomMode");
  if(el) el.checked = true;
  resetStickDiagrams();
}

function switchToRangeMode() {
  const el = document.getElementById("checkCircularityMode");
  if(el) el.checked = true;
  resetStickDiagrams();
}

const on_stick_mode_change = () => resetStickDiagrams();

const throttled_refresh_sticks = (() => {
  let delay = null;
  return function(changes) {
    if (!changes.sticks) return;
    if (delay) return;

    refresh_stick_pos();
    delay = setTimeout(() => {
      delay = null;
      refresh_stick_pos();
    }, 20);
  };
})();

const update_stick_graphics = (changes) => throttled_refresh_sticks(changes);

function update_battery_status({bat_txt, changed}) {
  if(changed) {
    const el = document.getElementById("d-bat");
    if(el) el.innerHTML = bat_txt;
  }
}

function update_ds_button_svg(changes, BUTTON_MAP) {
  if (!changes || Object.keys(changes).length === 0) return;

  const pressedColor = '#FFFFFF';
  const defaultColor = 'white';

  // Update L2/R2 bars
  for (const trigger of ['l2', 'r2']) {
    const key = trigger + '_analog';
    if (changes.hasOwnProperty(key)) {
      const val = changes[key]; // 0-255
      const percentage = Math.round((val / 255) * 100);
      
      // Update bar using cached elements or fallback
      const progressBar = (trigger === 'l2' ? domCache.l2_progress : domCache.r2_progress) || document.getElementById(`${trigger}-progress`);
      if (progressBar) {
          progressBar.style.width = percentage + '%';
          progressBar.textContent = percentage + '%';
      }

      // Update SVG
      const t = val / 255;
      const color = lerp_color(defaultColor, pressedColor, t); 
      const svg = trigger.toUpperCase() + '_infill';
      const infill = document.getElementById(svg);
      set_svg_group_color(infill, color);

      const outline = document.getElementById(trigger.toUpperCase() + '_outline');
      if (val > 10) {
        infill?.classList.add('pressed-glow');
        outline?.classList.add('pressed-glow');
      } else {
        infill?.classList.remove('pressed-glow');
        outline?.classList.remove('pressed-glow');
      }

      const percentageText = document.getElementById(trigger.toUpperCase() + '_percentage');
      if (percentageText) {
        percentageText.textContent = `${percentage} %`;
        percentageText.setAttribute('opacity', percentage > 0 ? '1' : '0');
        percentageText.setAttribute('fill', percentage < 35 ? '#1a237e' : 'white');
      }
    }
  }

  // Update Dpad
  for (const dir of ['up', 'right', 'down', 'left']) {
    if (changes.hasOwnProperty(dir)) {
      const pressed = changes[dir];
      const group = document.getElementById(dir.charAt(0).toUpperCase() + dir.slice(1) + '_infill');
      if (group) {
          if (pressed) group.classList.add('pressed-glow');
          else group.classList.remove('pressed-glow');
      }
      
      const indicator = document.getElementById(`indicator-${dir}`);
      if (indicator) {
          if (pressed) indicator.classList.add('pressed');
          else indicator.classList.remove('pressed');
      }
    }
  }

  // Update other buttons
  for (const btn of BUTTON_MAP) {
    if (['up', 'right', 'down', 'left'].includes(btn.name)) continue;
    if (changes.hasOwnProperty(btn.name)) {
      const pressed = changes[btn.name];
      
      if (btn.svg) {
        const group = document.getElementById(btn.svg + '_infill');
        if (group) {
            if (pressed) group.classList.add('pressed-glow');
            else group.classList.remove('pressed-glow');
        }
      }
      
      const indicator = document.getElementById(`indicator-${btn.name}`);
      if (indicator) {
          if (pressed) indicator.classList.add('pressed');
          else indicator.classList.remove('pressed');
      }
    }
  }
}

function set_svg_group_color(group, color) {
  if (group) {
    const elements = group.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon');
    elements.forEach(el => {
      el.style.fill = color;
      el.style.stroke = color;
    });
  }
}

let hasActiveTouchPoints = false;
let trackpadBbox = undefined;

function update_touchpad_circles(points) {
  const hasActivePointsNow = points.some(pt => pt.active);
  if(!hasActivePointsNow && !hasActiveTouchPoints) return;

  const svg = document.getElementById('controller-svg');
  const trackpad = svg?.querySelector('g#Trackpad_infill');
  if (!trackpad) return;

  // Remove previous points
  trackpad.querySelectorAll('circle.ds-touch').forEach(c => c.remove());
  hasActiveTouchPoints = hasActivePointsNow;
  
  if (!trackpadBbox) {
      const path = trackpad.querySelector('path');
      if (path) trackpadBbox = path.getBBox();
  }
  
  if (!trackpadBbox) return;

  points.forEach((pt, idx) => {
    if (!pt.active) return;
    
    const RAW_W = 1920, RAW_H = 943;
    const pointRadius = trackpadBbox.width * 0.05;
    const cx = trackpadBbox.x + pointRadius + (pt.x / RAW_W) * (trackpadBbox.width - pointRadius*2);
    const cy = trackpadBbox.y + pointRadius + (pt.y / RAW_H) * (trackpadBbox.height - pointRadius*2);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('class', 'ds-touch');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', pointRadius);
    circle.setAttribute('fill', idx === 0 ? '#2196f3' : '#e91e63');
    circle.setAttribute('fill-opacity', '0.5');
    circle.setAttribute('stroke', '#3399cc');
    circle.setAttribute('stroke-width', '4');
    trackpad.appendChild(circle);
  });
}

function initialize_button_indicators(BUTTON_MAP) {
  const container = document.getElementById('digital-buttons-container');
  if(!container) return;
  
  container.innerHTML = ''; 

  const iconMap = {
    'triangle': '<i class="fas fa-play fa-rotate-270" style="font-size: 0.8em; margin-left: 2px;"></i>',
    'circle': '<i class="far fa-circle"></i>',
    'cross': '<i class="fas fa-times"></i>',
    'square': '<i class="far fa-square"></i>',
    'l1': 'L1',
    'r1': 'R1',
    'l3': 'L3',
    'r3': 'R3',
    'up': '<i class="fas fa-arrow-up"></i>',
    'down': '<i class="fas fa-arrow-down"></i>',
    'left': '<i class="fas fa-arrow-left"></i>',
    'right': '<i class="fas fa-arrow-right"></i>',
    'ps': '<i class="fab fa-playstation"></i>',
    'create': '<i class="fas fa-share-square" style="font-size: 0.9em;"></i>',
    'options': '<i class="fas fa-bars"></i>',
    'touchpad': '<i class="fas fa-mouse-pointer"></i>',
    'mute': '<i class="fas fa-microphone-slash"></i>'
  };
  
  const buttons_to_show = Object.keys(iconMap);
  
  for (const btn of BUTTON_MAP) {
    if (buttons_to_show.includes(btn.name)) {
      const btn_name_translated = l(btn.name); 
      const icon = iconMap[btn.name];
      
      const span = document.createElement('span');
      span.id = `indicator-${btn.name}`;
      span.className = 'btn-indicator';
      span.setAttribute('title', btn_name_translated);
      span.innerHTML = icon;
      container.appendChild(span);
    }
  }
  
  // Initialize tooltips
  const tooltipTriggerList = Array.from(container.querySelectorAll('[title]'));
  tooltipTriggerList.map(function (tooltipTriggerEl) {
    if (!bootstrap.Tooltip.getInstance(tooltipTriggerEl)) {
      return new bootstrap.Tooltip(tooltipTriggerEl);
    }
  });
}

function get_current_main_tab() {
  const mainTabs = document.getElementById('mainTabs');
  const activeBtn = mainTabs?.querySelector('.nav-link.active');
  return activeBtn?.id || 'controller-tab';
}

function get_current_test_tab() {
  const testsList = document.getElementById('tests-list');
  const activeBtn = testsList?.querySelector('.list-group-item.active');
  return activeBtn?.id || 'haptic-test-tab';
}

function detectFailedRangeCalibration(changes) {
  if (!changes.sticks || app.shownRangeCalibrationWarning) return;

  const { left, right } = changes.sticks;
  const failedCalibration = [left, right].some(({x, y}) => Math.abs(x) + Math.abs(y) == 2);
  const hasOpenModals = document.querySelectorAll('.modal.show').length > 0;

  if (failedCalibration && !app.shownRangeCalibrationWarning && !hasOpenModals) {
    app.shownRangeCalibrationWarning = true;
    show_popup(l("Range calibration appears to have failed. Please try again and make sure you rotate the sticks."));
  }
}

// Callback function to handle UI updates after controller input processing
function handleControllerInput({ changes, inputConfig, touchPoints, batteryStatus }) {
  // Input Analysis Hook
  if (isInputAnalysisVisible()) {
    input_analysis_handle_input(performance.now());
  }

  const { buttonMap } = inputConfig;

  const current_active_tab = get_current_main_tab();
  switch (current_active_tab) {
    case 'controller-tab': // Main controller tab
      collectCircularityData(changes.sticks, ll_data, rr_data);
      if(isFinetuneVisible()) {
        finetune_handle_controller_input(changes);
      } else {
        update_stick_graphics(changes);
        update_ds_button_svg(changes, buttonMap);
        update_touchpad_circles(touchPoints);
        detectFailedRangeCalibration(changes);
      }
      break;

    case 'tests-tab':
      handle_test_input(changes);
      break;
  }

  update_battery_status(batteryStatus);
}

function handle_test_input(/* changes */) {
  const current_test_tab = get_current_test_tab();

  switch (current_test_tab) {
    case 'haptic-test-tab':
      const l2 = controller.button_states.l2_analog || 0;
      const r2 = controller.button_states.r2_analog || 0;
      if (l2 || r2) {
        // trigger_haptic_motors(l2, r2);
      }
      break;
    default:
      console.log("Unknown test tab:", current_test_tab);
      break;
  }
}

function update_disable_btn() {
  const { disable_btn, last_disable_btn } = app;
  if(disable_btn == last_disable_btn)
    return;

  if(disable_btn == 0) {
    document.querySelectorAll(".ds-btn").forEach(el => el.disabled = false);
    app.last_disable_btn = 0;
    return;
  }

  document.querySelectorAll(".ds-btn").forEach(el => el.disabled = true);

  if(disable_btn & 1 && !(last_disable_btn & 1)) {
    show_popup(l("The device appears to be a clone. All calibration functionality is disabled."));
  } else if(disable_btn & 2 && !(last_disable_btn & 2)) {
    show_popup(l("This DualSense controller has outdated firmware.") + "<br>" + l("Please update the firmware and try again."), true);
  }
  app.last_disable_btn = disable_btn;
}

async function handleLanguageChange() {
  if(!controller) return;

  const { infoItems } = await controller.getDeviceInfo();
  render_info_to_dom(infoItems);
}

function handleNvStatusUpdate(nv) {
  render_nvstatus_to_dom(nv);
}

async function flash_all_changes() {
  const isEdge = controller.getModel() == "DS5_Edge";
  const progressCallback = isEdge ? set_edge_progress : null;
  const modalEl = document.getElementById('edgeProgressModal');
  const edgeProgressModal = isEdge && modalEl ? bootstrap.Modal.getOrCreateInstance(modalEl) : null;
  
  if(edgeProgressModal) edgeProgressModal.show();

  const result = await controller.flash(progressCallback);
  if(edgeProgressModal) edgeProgressModal.hide();

  if (result?.success) {
    if(result.isHtml) {
      show_popup(result.message, result.isHtml);
    } else {
      successAlert(result.message);
    }
  }
}

async function reboot_controller() {
  await controller.reset();
}

async function nvsunlock() {
  await controller.nvsUnlock();
}

async function nvslock() {
  return await controller.nvsLock();
}

function close_all_modals() {
  document.querySelectorAll('.modal.show').forEach(el => {
      const modal = bootstrap.Modal.getInstance(el);
      if (modal) modal.hide();
  });
}

function render_info_to_dom(infoItems) {
  // Clear all info sections with null checks
  const fwInfo = document.getElementById("fwinfo");
  if (fwInfo) fwInfo.innerHTML = "";
  
  const fwInfoExtraHw = document.getElementById("fwinfoextra-hw");
  if (fwInfoExtraHw) fwInfoExtraHw.innerHTML = "";

  const fwInfoExtraFw = document.getElementById("fwinfoextra-fw");
  if (fwInfoExtraFw) fwInfoExtraFw.innerHTML = "";

  const dBoard = document.getElementById("d-board");
  if (dBoard) dBoard.textContent = ""; 

  if (!Array.isArray(infoItems)) return;

  infoItems.forEach(({key, value, addInfoIcon, severity, isExtra, cat}) => {
    if (!key) return;

    // Use English key for logic checks
    if (key === "Board Model" && dBoard) {
      dBoard.textContent = value;
    }

    let valueHtml = String(value ?? "");
    if (addInfoIcon === 'board') {
      const icon = '&nbsp;<a class="link-body-emphasis" href="#" onclick="board_model_info()">' +
      '<svg class="bi" width="1.3em" height="1.3em"><use xlink:href="#info"/></svg></a>';
      valueHtml += icon;
    } else if (addInfoIcon === 'color') {
      const icon = '&nbsp;<a class="link-body-emphasis" href="#" onclick="edge_color_info()">' +
      '<svg class="bi" width="1.3em" height="1.3em"><use xlink:href="#info"/></svg></a>';
      valueHtml += icon;
    }

    if (severity) {
      const colors = { danger: 'red', success: 'green' }
      const color = colors[severity] || 'black';
      valueHtml = `<font color='${color}'><b>${valueHtml}</b></font>`;
    }

    // Translate key for display
    const key_display = l(key);

    if (isExtra) {
      append_info_extra(key_display, valueHtml, cat || "hw");
    } else {
      append_info(key_display, valueHtml, cat || "hw");
    }
  });
}

function append_info_extra(key, value, cat) {
  const s = '<dt class="text-muted col-sm-4 col-md-6 col-xl-5">' + key + '</dt><dd class="col-sm-8 col-md-6 col-xl-7" style="text-align: right;">' + value + '</dd>';
  const el = document.getElementById("fwinfoextra-" + cat);
  if(el) el.innerHTML += s;
}


function append_info(key, value, cat) {
  const s = '<dt class="text-muted col-6">' + key + '</dt><dd class="col-6" style="text-align: right;">' + value + '</dd>';
  const el = document.getElementById("fwinfo");
  if(el) el.innerHTML += s;
  append_info_extra(key, value, cat);
}

function show_popup(text, is_html = false) {
  const el = document.getElementById("popupBody");
  if (!el) return;
  
  if(is_html) {
    el.innerHTML = text;
  } else {
    el.textContent = text;
  }
  const modalEl = document.getElementById('popupModal');
  if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function show_faq_modal() {
  la("faq_modal");
  const modalEl = document.getElementById('faqModal');
  if(modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function show_donate_modal() {
  la("donate_modal");
  const modalEl = document.getElementById('donateModal');
  if(modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function show_edge_modal() {
  const dontShowAgain = localStorage.getItem('edgeModalDontShowAgain');
  if (dontShowAgain === 'true') {
    return;
  }

  la("edge_modal");
  const modalEl = document.getElementById('edgeModal');
  if(modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function show_info_tab() {
  la("info_modal");
  const el = document.getElementById('info-tab');
  if(el) bootstrap.Tab.getOrCreateInstance(el).show();
}

function discord_popup() {
  la("discord_popup");
  show_popup(l("My handle on discord is: the_al"));
}

function edge_color_info() {
  la("cm_info");
  const text = l("Color detection thanks to") + ' romek77 from Poland.';
  show_popup(text, true);
}

function board_model_info() {
  la("bm_info");
  const l1 = l("This feature is experimental.");
  const l2 = l("Please let me know if the board model of your controller is not detected correctly.");
  const l3 = l("Board model detection thanks to") + ' <a href="https://battlebeavercustoms.com/">Battle Beaver Customs</a>.';
  show_popup(l3 + "<br><br>" + l1 + " " + l2, true);
}

// Alert Management Functions
let alertCounter = 0;

function pushAlert(message, type = 'info', duration = 0, dismissible = true) {
  const alertContainer = document.getElementById('alert-container');
  if (!alertContainer) {
  console.error('Alert container not found');
  return null;
  }

  const alertId = `alert-${++alertCounter}`;
  const alertDiv = document.createElement('div');
  alertDiv.id = alertId;
  alertDiv.className = `alert alert-${type} alert-dismissible fade show`;
  alertDiv.setAttribute('role', 'alert');
  alertDiv.innerHTML = `
    ${message}
    ${dismissible ? '<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>' : ''}
  `;

  alertContainer.appendChild(alertDiv);

  if (duration > 0) {
    setTimeout(() => {
      dismissAlert(alertId);
    }, duration);
  }

  return alertId;
}

function dismissAlert(alertId) {
  const alertElement = document.getElementById(alertId);
  if (alertElement) {
    const bsAlert = new bootstrap.Alert(alertElement);
    bsAlert.close();
  }
}

function clearAllAlerts() {
  const alertContainer = document.getElementById('alert-container');
  if (alertContainer) {
    const alerts = alertContainer.querySelectorAll('.alert');
    alerts.forEach(alert => {
      const bsAlert = new bootstrap.Alert(alert);
      bsAlert.close();
    });
  }
}

function successAlert(message, duration = 1_500) {
  return pushAlert(message, 'success', duration, false);
}

function errorAlert(message, duration = 15_000) {
  return pushAlert(message, 'danger', /* duration */);
}

function warningAlert(message, duration = 8_000) {
  return pushAlert(message, 'warning', duration);
}

function infoAlert(message, duration = 5_000) {
  return pushAlert(message, 'info', duration, false);
}

// Export functions to global scope for HTML onclick handlers
window.gboot = gboot;
window.connect = connect;
window.disconnect = disconnectSync;
window.show_faq_modal = show_faq_modal;
window.show_info_tab = show_info_tab;
window.calibrate_range = () => calibrate_range(
  controller,
  { ll_data, rr_data },
  (success, message) => {
    if (success) {
      resetStickDiagrams();
      successAlert(message);
      switchToRangeMode();
      app.shownRangeCalibrationWarning = false
    }
  }
);
window.calibrate_stick_centers = () => calibrate_stick_centers(
  controller,
  (success, message) => {
    if (success) {
      resetStickDiagrams();
      successAlert(message);
      switchTo10xZoomMode();
    }
  }
);
window.auto_calibrate_stick_centers = () => auto_calibrate_stick_centers(
  controller,
  (success, message) => {
    if (success) {
      resetStickDiagrams();
      successAlert(message);
      switchTo10xZoomMode();
    }
  }
);
window.ds5_finetune = () => ds5_finetune(
  controller,
  { ll_data, rr_data, clear_circularity },
  (success) => success && switchToRangeMode()
);
window.flash_all_changes = flash_all_changes;
window.reboot_controller = reboot_controller;
window.refresh_nvstatus = refresh_nvstatus;
window.nvsunlock = nvsunlock;
window.nvslock = nvslock;
window.show_donate_modal = show_donate_modal;
window.board_model_info = board_model_info;
window.edge_color_info = edge_color_info;

window.test_vibration = (duration = 150) => {
  console.log("Testing vibration...");
  controller.setVibration({ heavyLeft: 255, lightRight: 255, duration });
}

window.test_led = (color) => {
  console.log(`Testing LED: ${color}`);
  if (color === 'red') controller.currentController.setLightbarColor(255, 0, 0);
  if (color === 'green') controller.currentController.setLightbarColor(0, 255, 0);
  if (color === 'blue') controller.currentController.setLightbarColor(0, 0, 255);
  if (color === 'off') controller.currentController.setLightbarColor(0, 0, 0);
}

window.test_trigger = (side, preset) => {
  console.log(`Testing trigger ${side}: ${preset}`);
  
  const params = {
    left: side === 'left' ? preset : 'off',
    right: side === 'right' ? preset : 'off'
  };
  
  controller.setAdaptiveTriggerPreset(params);
}

window.show_input_analysis_modal = () => show_input_analysis_modal(controller);
window.toggle_input_analysis = toggle_input_analysis;
window.stop_input_analysis = stop_input_analysis;

// Auto-initialize the application when the module loads
gboot();