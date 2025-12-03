'use strict';

import { draw_stick_position } from '../stick-renderer.js';
import { dec2hex32, float_to_str, la } from '../utils.js';
import { auto_calibrate_stick_centers } from './calib-center-modal.js';
import { calibrate_range } from './calib-range-modal.js';

const FINETUNE_INPUT_SUFFIXES = ["LL", "LT", "RL", "RT", "LR", "LB", "RR", "RB", "LX", "LY", "RX", "RY"];
const LEFT_AND_RIGHT = ['left', 'right'];

// Configuration for stick-specific operations
const STICK_CONFIG = {
  left: {
    suffixes: ['LL', 'LT', 'LR', 'LB'],
    axisX: 'LX',
    axisY: 'LY',
    circDataName: 'll_data',
    canvasName: 'finetuneStickCanvasL'
  },
  right: {
    suffixes: ['RL', 'RT', 'RR', 'RB'],
    axisX: 'RX',
    axisY: 'RY',
    circDataName: 'rr_data',
    canvasName: 'finetuneStickCanvasR'
  }
};

// Event listener configurations
const EVENT_CONFIGS = [
  // Mode toggles
  { selector: '#finetuneModeCenter', event: 'change', handler: (instance, e) => e.target.checked && instance.setMode('center') },
  { selector: '#finetuneModeCircularity', event: 'change', handler: (instance, e) => e.target.checked && instance.setMode('circularity') },

  // General controls
  { selector: '#showRawNumbersCheckbox', event: 'change', handler: (instance) => instance._showRawNumbersChanged() },
  { selector: '#learn-more-link', event: 'click', handler: (instance, e) => { 
      e.preventDefault(); 
      document.getElementById('learn-more-link').style.display = 'none';
      document.getElementById('learn-more-text').style.display = 'block';
  }},
  { selector: '.dropdown-item[data-step]', event: 'click', handler: (instance, e) => { 
      e.preventDefault(); 
      instance.stepSize = parseInt(e.target.dataset.step); 
  }},

  // Modal events
  { selector: '#finetuneModal', event: 'hidden.bs.modal', handler: (instance) => instance._onModalHidden() }
];

/**
 * DS5 Finetuning Class
 * Handles controller stick calibration and fine-tuning operations
 * Refactored to Vanilla JS (ES6+)
 */
export class Finetune {
  constructor() {
    this._mode = 'center'; // 'center' or 'circularity'
    this.original_data = [];
    this.active_stick = null; // 'left', 'right', or null
    this._centerStepSize = 5; // Default step size for center mode
    this._circularityStepSize = 5; // Default step size for circularity mode
    this.isQuickCalibrating = false; // Prevents dialog destruction during quick calibration

    // Dependencies
    this.controller = null;
    this.ll_data = null;
    this.rr_data = null;
    this.clearCircularity = null;
    this.doneCallback = null;

    // Closure functions
    this.refresh_finetune_sticks = this._createRefreshSticksThrottled();
    this.update_finetune_warning_messages = this._createUpdateWarningMessagesClosure();
    this.flash_finetune_warning = this._createFlashWarningClosure();

    // Continuous adjustment state
    this.continuous_adjustment = {
      initial_delay: null,
      repeat_delay: null,
    };

    // Track previous slider values for incremental adjustments
    this._previousSliderValues = {
      left: 0,
      right: 0
    };

    // Store the values of the input fields when slider adjustment starts
    this._inputStartValuesForSlider = {
      left: null,
      right: null
    };

    // Track slider usage state for undo functionality
    this._sliderUsed = {
      left: false,
      right: false
    };

    // Track previous axis values for stopping continuous adjustment
    this._previousAxisValues = {
      left: { x: 0, y: 0 },
      right: { x: 0, y: 0 }
    };

    // Event listener tracking
    this._activeListeners = [];
  }

  get mode() {
    return this._mode;
  }

  set mode(mode) {
    if (mode !== 'center' && mode !== 'circularity') {
      throw new Error(`Invalid finetune mode: ${mode}. Must be 'center' or 'circularity'`);
    }
    this._mode = mode;
    this._updateUI();
  }

  get stepSize() {
    return this._mode === 'center' ? this._centerStepSize : this._circularityStepSize;
  }

  set stepSize(size) {
    if (this._mode === 'center') {
      this._centerStepSize = size;
    } else {
      this._circularityStepSize = size;
    }
    this._updateStepSizeUI();
    this._saveStepSizeToLocalStorage();
  }

  async init(controllerInstance, { ll_data, rr_data, clear_circularity }, doneCallback = null) {
    la("finetune_modal_open");

    this.controller = controllerInstance;
    this.ll_data = ll_data;
    this.rr_data = rr_data;
    this.clearCircularity = clear_circularity;
    this.doneCallback = doneCallback;

    this._initEventListeners();
    this._restoreShowRawNumbersCheckbox();
    this._restoreStepSizeFromLocalStorage();

    // Lock NVS before
    const nv = await this.controller.queryNvStatus();
    if(!nv.locked) {
      const res = await this.controller.nvsLock();
      if(!res.ok) {
        return;
      }

      const nv2 = await this.controller.queryNvStatus();
      if(!nv2.locked) {
        const errTxt = "0x" + dec2hex32(nv2.raw);
        throw new Error("ERROR: Cannot lock NVS (" + errTxt + ")");
      }
    } else if(nv.status !== 'locked') {
      throw new Error("ERROR: Cannot read NVS status. Finetuning is not safe on this device.");
    }

    const data = await this._readFinetuneData();

    const modalEl = document.getElementById('finetuneModal');
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();

    this._initializeFinetuneInputs(data);

    // Start in center mode
    this.setMode('center');
    this.setStickToFinetune('left');

    // Initialize the raw numbers display state
    this._showRawNumbersChanged();

    this.original_data = data;

    // Update error slack button states
    this._updateErrorSlackButtonStates();

    // Reset the Learn More link
    document.getElementById('learn-more-link').style.display = 'inline';
    document.getElementById('learn-more-text').style.display = 'none';

    this.refresh_finetune_sticks();
  }

  /**
   * Helper to add and track event listeners
   */
  _addListener(element, event, handler) {
    if (element) {
      element.addEventListener(event, handler);
      this._activeListeners.push({ element, event, handler });
    }
  }

  /**
   * Initialize event listeners for the finetune modal
   */
  _initEventListeners() {
    // Initialize finetune input listeners
    FINETUNE_INPUT_SUFFIXES.forEach((suffix) => {
      const el = document.getElementById("finetune" + suffix);
      if (el) {
        this._addListener(el, 'change', () => this._onFinetuneChange());
      }
    });

    // Initialize general event listeners
    EVENT_CONFIGS.forEach(config => {
        const elements = document.querySelectorAll(config.selector);
        elements.forEach(el => {
            this._addListener(el, config.event, (e) => config.handler(this, e));
        });
    });

    // Initialize stick-specific event listeners
    this._initStickEventListeners();
  }

  /**
   * Initialize stick-specific event listeners (left and right)
   */
  _initStickEventListeners() {
    LEFT_AND_RIGHT.forEach(lOrR => {
      const card = document.getElementById(`${lOrR}-stick-card`);
      if (card) {
        this._addListener(card, 'click', () => {
            this.setStickToFinetune(lOrR);
        });
      }

      this._initSliderListeners(lOrR);
      this._initButtonListeners(lOrR);
    });
  }

  /**
   * Initialize slider event listeners for a specific stick
   */
  _initSliderListeners(lOrR) {
    const sliderId = `${lOrR}CircularitySlider`;
    const slider = document.getElementById(sliderId);

    if (slider) {
        this._addListener(slider, 'input', (e) => {
            this._onCircularitySliderChange(lOrR, parseInt(e.target.value));
        });

        const startHandler = (e) => {
            this._onCircularitySliderStart(lOrR, parseInt(e.target.value));
        };
        this._addListener(slider, 'mousedown', startHandler);
        this._addListener(slider, 'touchstart', startHandler);

        this._addListener(slider, 'change', (e) => {
            this._onCircularitySliderRelease(lOrR);
        });
    }
  }

  /**
   * Initialize button event listeners for a specific stick
   */
  _initButtonListeners(lOrR) {
    // Reset button
    const resetBtn = document.getElementById(`${lOrR}CircularityResetBtn`);
    if (resetBtn) {
        this._addListener(resetBtn, 'click', () => this._resetCircularitySlider(lOrR));
    }

    // Error slack button
    const slackBtn = document.getElementById(`${lOrR}ErrorSlackBtn`);
    if (slackBtn) {
        this._addListener(slackBtn, 'click', () => this._onErrorSlackButtonClick(lOrR));
    }

    // Error slack undo button
    const undoBtn = document.getElementById(`${lOrR}ErrorSlackUndoBtn`);
    if (undoBtn) {
        this._addListener(undoBtn, 'click', () => this._onErrorSlackUndoButtonClick(lOrR));
    }
  }

  /**
   * Clean up event listeners for the finetune modal
   */
  removeEventListeners() {
    this._activeListeners.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    this._activeListeners = [];
  }

  /**
   * Handle modal hidden event
   */
  _onModalHidden() {
    console.log("Finetune modal hidden event triggered");

    // Don't destroy the instance if quick calibration is in progress
    if (this.isQuickCalibrating) {
      console.log("Quick calibration in progress, preventing dialog destruction");
      return;
    }

    // Reset circularity sliders to zero when modal closes
    LEFT_AND_RIGHT.forEach(lOrR => {
      const slider = document.getElementById(`${lOrR}CircularitySlider`);
      if (slider) slider.value = 0;
      this._sliderUsed[lOrR] = false;
    });

    destroyCurrentInstance();
  }

  /**
   * Handle mode switching based on controller input
   */
  handleModeSwitching(changes) {
    if (changes.l1) {
      this.setMode('center');
      this._clearFinetuneAxisHighlights();
    } else if (changes.r1) {
      this.setMode('circularity');
      this._clearFinetuneAxisHighlights();
    }
  }

  /**
   * Handle stick switching based on controller input
   */
  handleStickSwitching(changes) {
    if (changes.sticks) {
      this._updateActiveStickBasedOnMovement();
    }
  }

  /**
   * Handle D-pad adjustments for finetuning
   */
  handleDpadAdjustment(changes) {
    if(!this.active_stick) return;

    if (this._mode === 'center') {
      this._handleCenterModeAdjustment(changes);
    } else {
      this._handleCircularityModeAdjustment(changes);
    }
  }

  /* Set the quick calibrating state to prevent dialog destruction
  * @param {boolean} isCalibrating - Whether quick calibration is in progress
  */
  setQuickCalibrating(isCalibrating) {
    this.isQuickCalibrating = isCalibrating;
    const finetuneModalEl = document.getElementById('finetuneModal');
    const finetuneModal = bootstrap.Modal.getInstance(finetuneModalEl);
    
    if (isCalibrating) {
        finetuneModal.hide();
    } else {
        finetuneModal.show();
        this.clearCircularity();

        // Refresh the finetune data after calibration
        this._readFinetuneData().then((data) => {
            this._initializeFinetuneInputs(data);
            this.refresh_finetune_sticks();
            console.log('Finetune modal refreshed');
        });
    }
  }

  /**
   * Save finetune changes
   */
  save() {
    // Unlock save button
    this.controller.setHasChangesToWrite(true);

    this._close(true);
  }

  /**
   * Cancel finetune changes and restore original data
   */
  async cancel() {
    if(this.original_data.length == 12)
      await this._writeFinetuneData(this.original_data)

    this._close(false);
  }

  /**
   * Set the finetune mode
   */
  setMode(mode) {
    this._mode = mode;
    this._updateUI();

    // Reset toggle states when switching modes
    if (mode === 'center') {
      LEFT_AND_RIGHT.forEach(lOrR => {
        const card = document.getElementById(`${lOrR}-stick-card`);
        if (card) card.classList.remove('show-slider');
        this._sliderUsed[lOrR] = false;
        this._showErrorSlackButton(lOrR);
      });
    }
  }

  /**
   * Set which stick to finetune
   */
  setStickToFinetune(lOrR) {
    if(this.active_stick === lOrR) {
      return;
    }

    // Stop any continuous adjustments when switching sticks
    this.stopContinuousDpadAdjustment();
    this._clearFinetuneAxisHighlights();

    // Hide slider on the previously active stick (when it becomes inactive)
    if (this.active_stick && this._mode === 'circularity') {
      const previousStickCard = document.getElementById(`${this.active_stick}-stick-card`);
      if (previousStickCard) previousStickCard.classList.remove('show-slider');
    }

    this.active_stick = lOrR;

    const other_stick = lOrR === 'left' ? 'right' : 'left';
    document.getElementById(`${this.active_stick}-stick-card`)?.classList.add("stick-card-active");
    document.getElementById(`${other_stick}-stick-card`)?.classList.remove("stick-card-active");
  }

  // Private methods

  /**
   * Restore the show raw numbers checkbox state from localStorage
   */
  _restoreShowRawNumbersCheckbox() {
    const savedState = localStorage.getItem('showRawNumbersCheckbox');
    if (savedState) {
      const isChecked = savedState === 'true';
      const checkbox = document.getElementById("showRawNumbersCheckbox");
      if (checkbox) checkbox.checked = isChecked;
    }
  }

  /**
   * Initialize finetune input fields with data and max values
   * @param {Array} data - Array of finetune values
   */
  _initializeFinetuneInputs(data) {
    const maxValue = this.controller.getFinetuneMaxValue();
    FINETUNE_INPUT_SUFFIXES.forEach((suffix, i) => {
      const el = document.getElementById("finetune" + suffix);
      if (el) {
          el.setAttribute('max', maxValue);
          el.value = data[i];
      }
    });
  }

  /**
   * Check if stick is in extreme position (close to edges)
   * @param {Object} stick - Stick object with x and y properties
   * @returns {boolean} True if stick is in extreme position
   */
  _isStickInExtremePosition(stick) {
    const primeAxis = Math.max(Math.abs(stick.x), Math.abs(stick.y));
    const otherAxis = Math.min(Math.abs(stick.x), Math.abs(stick.y));
    return primeAxis >= 0.5 && otherAxis < 0.2;
  }

  _updateUI() {
    // Clear circularity data - we'll call this from core.js
    this.clearCircularity();

    const modal = document.getElementById('finetuneModal');
    if (this._mode === 'center') {
      const radio = document.getElementById("finetuneModeCenter");
      if (radio) radio.checked = true;
      modal.classList.remove('circularity-mode');
    } else if (this._mode === 'circularity') {
      const radio = document.getElementById("finetuneModeCircularity");
      if (radio) radio.checked = true;
      modal.classList.add('circularity-mode');
    }

    // Update step size UI when mode changes
    this._updateStepSizeUI();

    // Update error slack button states when mode changes
    this._updateErrorSlackButtonStates();
  }

  async _onFinetuneChange() {
    const out = FINETUNE_INPUT_SUFFIXES.map((suffix) => {
      const el = document.getElementById("finetune" + suffix);
      const v = parseInt(el?.value);
      return isNaN(v) ? 0 : v;
    });
    await this._writeFinetuneData(out);
  }

  async _readFinetuneData() {
    const data = await this.controller.getInMemoryModuleData();
    if(!data) {
      throw new Error("ERROR: Cannot read calibration data");
    }

    return data;
  }

  async _writeFinetuneData(data) {
    if (data.length != 12) {
      return;
    }

    if (this.controller.isConnected()) {
      await this.controller.writeFinetuneData(data);
    }
  }

  _createRefreshSticksThrottled() {
    let timeout = null;

    return () => {
      if (timeout) return;

      timeout = setTimeout(() => {
        const sticks = this.controller.button_states.sticks;

        // Update both stick displays using configuration
        Object.entries(STICK_CONFIG).forEach(([stick, config]) => {
          const stickData = sticks[stick];
          this._ds5FinetuneUpdate(config.canvasName, stickData.x, stickData.y);
        });

        this.update_finetune_warning_messages();
        this._highlightActiveFinetuneAxis();
        this._updateErrorSlackButtonStates();

        timeout = null;
      }, 10);
    };
  }

  _createUpdateWarningMessagesClosure() {
    let timeout = null; // to prevent unnecessary flicker

    return () => {
      if(!this.active_stick) return;

      const currentStick = this.controller.button_states.sticks[this.active_stick];
      
      const centerSuccess = document.getElementById('finetuneCenterSuccess');
      const centerWarning = document.getElementById('finetuneCenterWarning');
      const circSuccess = document.getElementById('finetuneCircularitySuccess');
      const circWarning = document.getElementById('finetuneCircularityWarning');

      if (this._mode === 'center') {
        const isNearCenter = Math.abs(currentStick.x) <= 0.5 && Math.abs(currentStick.y) <= 0.5;
        if(!isNearCenter && timeout) return;

        clearTimeout(timeout);
        timeout = setTimeout(() => {
          timeout = null;
          if(this._mode !== 'center') return; 

          if (centerSuccess) centerSuccess.style.display = isNearCenter ? 'block' : 'none';
          if (centerWarning) centerWarning.style.display = !isNearCenter ? 'block' : 'none';
        }, isNearCenter ? 0 : 200);
      }

      if (this._mode === 'circularity') {
        const isInExtremePosition = this._isStickInExtremePosition(currentStick);
        if(!isInExtremePosition && timeout) return;

        clearTimeout(timeout);
        timeout = setTimeout(() => {
          timeout = null;
          if(this._mode !== 'circularity') return; 

          if (circSuccess) circSuccess.style.display = isInExtremePosition ? 'block' : 'none';
          if (circWarning) circWarning.style.display = !isInExtremePosition ? 'block' : 'none';
        }, isInExtremePosition ? 0 : 200);
      }
    };
  }

  _clearFinetuneAxisHighlights(to_clear = {center: true, circularity: true}) {
    const { center, circularity } = to_clear;

    if((this._mode === 'center' && center) || (this._mode === 'circularity' && circularity)) {
      // Clear label highlights
      const labelIds = ["Lx-lbl", "Ly-lbl", "Rx-lbl", "Ry-lbl"];
      labelIds.forEach(suffix => {
        const el = document.getElementById(`finetuneStickCanvas${suffix}`);
        if(el) el.classList.remove("text-primary");
      });
    }
  }

  _highlightActiveFinetuneAxis(opts = {}) {
    if(!this.active_stick) return;

    if (this._mode === 'center') {
      const { axis } = opts;
      if(!axis) return;

      this._clearFinetuneAxisHighlights({center: true});

      const labelSuffix = `${this.active_stick === 'left' ? "L" : "R"}${axis.toLowerCase()}`;
      const el = document.getElementById(`finetuneStickCanvas${labelSuffix}-lbl`);
      if (el) el.classList.add("text-primary");
    } else {
      this._clearFinetuneAxisHighlights({circularity: true});

      const sticks = this.controller.button_states.sticks;
      const currentStick = sticks[this.active_stick];

      // Only highlight if stick is moved significantly from center
      const deadzone = 0.5;
      if (Math.abs(currentStick.x) >= deadzone || Math.abs(currentStick.y) >= deadzone) {
        const quadrant = this._getStickQuadrant(currentStick.x, currentStick.y);
        const inputSuffix = this._getFinetuneInputSuffixForQuadrant(this.active_stick, quadrant);
        if (inputSuffix) {
          // Highlight the corresponding LX/LY label to observe
          const labelId = `finetuneStickCanvas${
            this.active_stick === 'left' ? 'L' : 'R'}${
              quadrant === 'left' || quadrant === 'right' ? 'x' : 'y'}-lbl`;
              const el = document.getElementById(labelId);
              if (el) el.classList.add("text-primary");
            }
          }
        }
      }

  _ds5FinetuneUpdate(name, plx, ply) {
    const checkbox = document.getElementById("showRawNumbersCheckbox");
    const showRawNumbers = checkbox && checkbox.checked;
    const canvasId = `${name}${showRawNumbers ? '' : '_large'}`;
    const c = document.getElementById(canvasId);

    if (!c) {
      console.error(`Canvas element not found: ${canvasId}`);
      return;
    }

    const ctx = c.getContext("2d");

    const margins = 5;
    const radius = c.width / 2 - margins;
    const sz = c.width/2 - margins;
    const hb = radius + margins;
    const yb = radius + margins;
    ctx.clearRect(0, 0, c.width, c.height);

    // Determine which stick this is using configuration
    const lOrR = this._getStickFromCanvasName(name);
    const highlight = this.active_stick === lOrR && this._isDpadAdjustmentActive();

    if (this._mode === 'circularity') {
      // Draw stick position with circle
      const circularityData = lOrR === 'left' ? this.ll_data : this.rr_data;
      draw_stick_position(ctx, hb, yb, sz, plx, ply, {
        circularity_data: circularityData,
        highlight
      });
    } else {
      // Draw stick position with crosshair
      draw_stick_position(ctx, hb, yb, sz, plx, ply, {
        enable_zoom_center: true,
        highlight
      });
    }

    const lblX = document.getElementById(name + "x-lbl");
    if(lblX) lblX.textContent = float_to_str(plx, 3);
    
    const lblY = document.getElementById(name + "y-lbl");
    if(lblY) lblY.textContent = float_to_str(ply, 3);
  }

  /**
   * Get lOrR from canvas name using configuration
   */
  _getStickFromCanvasName(canvasName) {
    return LEFT_AND_RIGHT.find(lOrR =>
      STICK_CONFIG[lOrR].canvasName === canvasName
    );
  }

  _showRawNumbersChanged() {
    const checkbox = document.getElementById("showRawNumbersCheckbox");
    const showRawNumbers = checkbox && checkbox.checked;
    const modal = document.getElementById("finetuneModal");
    if (modal) {
        if (!showRawNumbers) modal.classList.add("hide-raw-numbers");
        else modal.classList.remove("hide-raw-numbers");
    }
    localStorage.setItem('showRawNumbersCheckbox', showRawNumbers);

    this.refresh_finetune_sticks();
  }

  _close(success = false, message = null) {
    console.log("Closing finetune modal");

    // Call the done callback if provided
    if (this.doneCallback && typeof this.doneCallback === 'function') {
      this.doneCallback(success, message);
    }

    const modalEl = document.getElementById('finetuneModal');
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.hide();
  }

  _isStickAwayFromCenter(stick_pos, deadzone = 0.2) {
    return Math.abs(stick_pos.x) >= deadzone || Math.abs(stick_pos.y) >= deadzone;
  }

  _updateActiveStickBasedOnMovement() {
    const sticks = this.controller.button_states.sticks;
    const deadzone = 0.2;

    const left_is_away = this._isStickAwayFromCenter(sticks.left, deadzone);
    const right_is_away = this._isStickAwayFromCenter(sticks.right, deadzone);

    if (left_is_away && right_is_away) {
      // Both sticks are away from center - clear highlighting
      this._clearActiveStick();
    } else if (left_is_away && !right_is_away) {
      // Only left stick is away from center
      this.setStickToFinetune('left');
    } else if (right_is_away && !left_is_away) {
      // Only right stick is away from center
      this.setStickToFinetune('right');
    }
    // If both sticks are centered, keep current active stick (no change)
  }

  _clearActiveStick() {
    // Remove active class from both cards
    document.getElementById("left-stick-card")?.classList.remove("stick-card-active");
    document.getElementById("right-stick-card")?.classList.remove("stick-card-active");

    this.active_stick = null; // Clear active stick
    this._clearFinetuneAxisHighlights();
  }

  _getStickQuadrant(x, y) {
    // Determine which quadrant the stick is in based on x,y coordinates
    // x and y are normalized values between -1 and 1
    if (Math.abs(x) > Math.abs(y)) {
      return x > 0 ? 'right' : 'left';
    } else {
      return y > 0 ? 'down' : 'up';
    }
  }

  _getFinetuneInputSuffixForQuadrant(stick, quadrant) {
    // This function should only be used in circularity mode
    if (this._mode === 'center') {
      console.warn('get_finetune_input_suffix_for_quadrant called in center mode - this should not happen');
      return null;
    }

    // Circularity mode: map quadrants to specific calibration points using configuration
    const config = STICK_CONFIG[stick];
    if (!config) return null;

    const quadrantMap = {
      'left': 0,   // LL, RL
      'up': 1,     // LT, RT
      'right': 2,  // LR, RR
      'down': 3    // LB, RB
    };

    const index = quadrantMap[quadrant];
    return index !== undefined ? config.suffixes[index] : null;
  }

  _handleCenterModeAdjustment(changes) {
    const adjustmentStep = this._centerStepSize; // Use center step size for center mode

    // Define button mappings for center mode
    const buttonMappings = [
      { buttons: ['left', 'square'], adjustment: adjustmentStep, axis: 'X' },
      { buttons: ['right', 'circle'], adjustment: -adjustmentStep, axis: 'X' },
      { buttons: ['up', 'triangle'], adjustment: adjustmentStep, axis: 'Y' },
      { buttons: ['down', 'cross'], adjustment: -adjustmentStep, axis: 'Y' }
    ];

    // Check if any relevant button was released
    const relevantButtons = ['left', 'right', 'square', 'circle', 'up', 'down', 'triangle', 'cross'];
    if (relevantButtons.some(button => changes[button] === false)) {
      this.stopContinuousDpadAdjustment();
      return;
    }

    // Check for button presses
    for (const mapping of buttonMappings) {
      // Check if active stick is away from center (> 0.5)
      const sticks = this.controller.button_states.sticks;
      const currentStick = sticks[this.active_stick];
      const stickAwayFromCenter = Math.abs(currentStick.x) > 0.5 || Math.abs(currentStick.y) > 0.5;
      if (stickAwayFromCenter && this._isNavigationKeyPressed()) {
        this.flash_finetune_warning();
        return;
      }

      if (mapping.buttons.some(button => changes[button])) {
        this._highlightActiveFinetuneAxis({axis: mapping.axis});
        this._startContinuousDpadAdjustmentCenterMode(this.active_stick, mapping.axis, mapping.adjustment);
        return;
      }
    }
  }

  _isNavigationKeyPressed() {
    const nav_buttons = ['left', 'right', 'up', 'down', 'square', 'circle', 'triangle', 'cross'];
    return nav_buttons.some(button => this.controller.button_states[button] === true);
  }

  _createFlashWarningClosure() {
    let timeout = null;

    return () => {
      function toggle() {
        const centerWarn = document.getElementById("finetuneCenterWarning");
        const circWarn = document.getElementById("finetuneCircularityWarning");
        
        if(centerWarn) {
            centerWarn.classList.toggle('alert-warning');
            centerWarn.classList.toggle('alert-danger');
        }
        if(circWarn) {
            circWarn.classList.toggle('alert-warning');
            circWarn.classList.toggle('alert-danger');
        }
      }

      if(timeout) return;

      toggle();   // on
      timeout = setTimeout(() => {
        toggle();   // off
        timeout = null;
      }, 300);
    };
  }

  _handleCircularityModeAdjustment({sticks: _, ...changes}) {
    const sticks = this.controller.button_states.sticks;
    const currentStick = sticks[this.active_stick];

    // Only adjust if stick is moved significantly from center
    const isInExtremePosition = this._isStickInExtremePosition(currentStick);
    if (!isInExtremePosition) {
      this.stopContinuousDpadAdjustment();
      if(this._isNavigationKeyPressed()) {
        this.flash_finetune_warning();
      }
      return;
    }

    const quadrant = this._getStickQuadrant(currentStick.x, currentStick.y);

    // Use circularity step size for circularity mode
    const adjustmentStep = this._circularityStepSize;

    // Define button mappings for each quadrant type
    const horizontalButtons = ['left', 'right', 'square', 'circle'];
    const verticalButtons = ['up', 'down', 'triangle', 'cross'];

    let adjustment = 0;
    let relevantButtons = [];

    if (quadrant === 'left' || quadrant === 'right') {
      // Horizontal quadrants: left increases, right decreases
      relevantButtons = horizontalButtons;
      if (changes.left || changes.square) {
        adjustment = adjustmentStep;
      } else if (changes.right || changes.circle) {
        adjustment = -adjustmentStep;
      }
    } else if (quadrant === 'up' || quadrant === 'down') {
      // Vertical quadrants: up increases, down decreases
      relevantButtons = verticalButtons;
      if (changes.up || changes.triangle) {
        adjustment = adjustmentStep;
      } else if (changes.down || changes.cross) {
        adjustment = -adjustmentStep;
      }
    }

    // Check if any relevant button was released
    if (relevantButtons.some(button => changes[button] === false)) {
      this.stopContinuousDpadAdjustment();
      return;
    }

    // Start continuous adjustment on button press
    if (adjustment !== 0) {
      this._startContinuousDpadAdjustment(this.active_stick, quadrant, adjustment);
    }
  }

  _startContinuousDpadAdjustment(stick, quadrant, adjustment) {
    const inputSuffix = this._getFinetuneInputSuffixForQuadrant(stick, quadrant);
    this._startContinuousAdjustmentWithSuffix(inputSuffix, adjustment);
  }

  _startContinuousDpadAdjustmentCenterMode(stick, targetAxis, adjustment) {
    // In center mode, directly map to X/Y axes using configuration
    const config = STICK_CONFIG[stick];
    const inputSuffix = targetAxis === 'X' ? config.axisX : config.axisY;
    this._startContinuousAdjustmentWithSuffix(inputSuffix, adjustment);
  }

  _startContinuousAdjustmentWithSuffix(inputSuffix, adjustment) {
    this.stopContinuousDpadAdjustment();

    const element = document.getElementById(`finetune${inputSuffix}`);
    if (!element) return;

    // Initialize previous axis values for the active stick
    if (this.active_stick && this.controller.button_states.sticks) {
      const currentStick = this.controller.button_states.sticks[this.active_stick];
      this._previousAxisValues[this.active_stick].x = currentStick.x;
      this._previousAxisValues[this.active_stick].y = currentStick.y;
    }

    // Perform initial adjustment immediately...
    this._performDpadAdjustment(element, adjustment);
    this.clearCircularity();

    // ...then prime continuous adjustment
    this.continuous_adjustment.initial_delay = setTimeout(() => {
      this.continuous_adjustment.repeat_delay = setInterval(() => {
        this._performDpadAdjustment(element, adjustment);
        this.clearCircularity();
      }, 150);
    }, 400); // Initial delay before continuous adjustment starts (400ms)
  }

  stopContinuousDpadAdjustment() {
    if (this.continuous_adjustment.repeat_delay) {
        clearInterval(this.continuous_adjustment.repeat_delay);
        this.continuous_adjustment.repeat_delay = null;
    }

    if (this.continuous_adjustment.initial_delay) {
        clearTimeout(this.continuous_adjustment.initial_delay);
        this.continuous_adjustment.initial_delay = null;
    }
  }

  _isDpadAdjustmentActive() {
    return !!this.continuous_adjustment.initial_delay;
  }

  async _performDpadAdjustment(element, adjustment) {
    const currentValue = parseInt(element.value) || 0;
    const maxValue = this.controller.getFinetuneMaxValue();

    const newValue = Math.max(0, Math.min(maxValue, currentValue + adjustment));
    element.value = newValue;

    // Trigger the change event to update the finetune data
    await this._onFinetuneChange();

    // Check if axis values have dropped from 1.00 to below 1.00 and stop adjustment if so
    this._checkAxisValuesForStopCondition();
  }

  /**
   * Check if axis values have dropped from 1.00 to below 1.00 and stop adjustment
   */
  _checkAxisValuesForStopCondition() {
    if (!this.active_stick || !this.continuous_adjustment.repeat_delay) {
      return; // No continuous adjustment active
    }

    const currentStick = this.controller.button_states.sticks[this.active_stick];
    const previousStick = this._previousAxisValues[this.active_stick];

    // Check if X axis dropped from 1.00+ to below 1.00
    const xDropped = Math.abs(previousStick.x) >= 1.00 && Math.abs(currentStick.x) < 1.00;
    // Check if Y axis dropped from 1.00+ to below 1.00
    const yDropped = Math.abs(previousStick.y) >= 1.00 && Math.abs(currentStick.y) < 1.00;

    if (xDropped || yDropped) {
      console.log(`Stopping continuous adjustment: ${this.active_stick} axis dropped below 1.00`);
      this.stopContinuousDpadAdjustment();
    }

    // Update previous values for next check
    this._previousAxisValues[this.active_stick] = currentStick;
  }

  /**
   * Update the step size UI display
   */
  _updateStepSizeUI() {
    const currentStepSize = this._mode === 'center' ? this._centerStepSize : this._circularityStepSize;
    document.getElementById('stepSizeValue').textContent = currentStepSize;
  }

  /**
   * Save step size to localStorage
   */
  _saveStepSizeToLocalStorage() {
    localStorage.setItem('finetuneCenterStepSize', this._centerStepSize.toString());
    localStorage.setItem('finetuneCircularityStepSize', this._circularityStepSize.toString());
  }

  /**
   * Restore step size from localStorage
   */
  _restoreStepSizeFromLocalStorage() {
    // Restore center step size
    const savedCenterStepSize = localStorage.getItem('finetuneCenterStepSize');
    if (savedCenterStepSize) {
      this._centerStepSize = parseInt(savedCenterStepSize);
    }

    // Restore circularity step size
    const savedCircularityStepSize = localStorage.getItem('finetuneCircularityStepSize');
    if (savedCircularityStepSize) {
      this._circularityStepSize = parseInt(savedCircularityStepSize);
    }

    this._updateStepSizeUI();
  }

  /**
   * Reset circularity sliders to zero position
   */
  _resetCircularitySliders() {
    const left = document.getElementById("leftCircularitySlider");
    if(left) left.value = 0;
    const right = document.getElementById("rightCircularitySlider");
    if(right) right.value = 0;
  }

  /**
   * Handle the start of circularity slider adjustment
   * Store base values and reset previous slider value
   */
  _onCircularitySliderStart(lOrR, value) {
    console.log(`Slider start for ${lOrR} stick, value: ${value}`);

    const config = STICK_CONFIG[lOrR];
    const baseValues = {};

    // Store the base values when slider adjustment starts
    config.suffixes.forEach(suffix => {
      const element = document.getElementById(`finetune${suffix}`);
      baseValues[suffix] = parseInt(element?.value) || 0;
    });

    this._inputStartValuesForSlider[lOrR] = baseValues;
    this._previousSliderValues[lOrR] = value;

    // Store base values for circularity data arrays
    const circData = this[config.circDataName];
    if (circData && Array.isArray(circData)) {
      this._inputStartValuesForSlider[lOrR][config.circDataName] = [...circData]; // Create a copy
    }

    console.log(`Base values stored for ${lOrR}:`, baseValues);
  }

  /**
   * Handle circularity slider changes with incremental adjustments
   */
  _onCircularitySliderChange(lOrR, value) {
    // Debug: Log the data structure
    console.log(`Slider change for ${lOrR} stick, value: ${value}`);

    // If we don't have base values, treat this as the start
    if (!this._inputStartValuesForSlider[lOrR]) {
      this._onCircularitySliderStart(lOrR, value);
      return;
    }

    // Calculate the incremental change from the previous slider position
    const previousValue = this._previousSliderValues[lOrR];
    const deltaValue = value - previousValue;

    // If no change, return early
    if (deltaValue === 0) {
      return;
    }

    // Get the start values and suffixes for the current stick
    const config = STICK_CONFIG[lOrR];
    const startValues = this._inputStartValuesForSlider[lOrR];

    // Calculate the total adjustment based on slider value from 0
    // Value 0-100 maps to adjustment range (we'll use a reasonable range)
    const maxAdjustment = 175; // Adjust this value as needed
    const totalAdjustment = (value / 100) * maxAdjustment;

    config.suffixes.forEach(suffix => {
      const element = document.getElementById(`finetune${suffix}`);
      let newValue;

      if (suffix.endsWith('L') || suffix.endsWith('T')) {
        newValue = Math.min(65535, startValues[suffix] + totalAdjustment);
      } else if (suffix.endsWith('R') || suffix.endsWith('B')) {
        newValue = Math.max(0, startValues[suffix] - totalAdjustment);
      }

      if (element) element.value = Math.round(newValue);
    });

    // Update circularity data with incremental changes proportional to slider movement
    const adjustmentConstant = 0.00085; // Small constant for incremental adjustments
    const totalAdjustmentFromBase = totalAdjustment * adjustmentConstant; // Total adjustment from slider position 0

    const startingData = this._inputStartValuesForSlider[lOrR][config.circDataName];
    const circData = this[config.circDataName];

    // Apply total adjustment from base values to maintain relative differences
    startingData.forEach((value, i) => circData[i] = Math.max(0, value + totalAdjustmentFromBase));

    // Convert polar coordinates to cartesian, trim to square, and convert back
    this._trimCircularityDataToSquare(circData);

    // Update previous slider value
    this._previousSliderValues[lOrR] = value;

    // Refresh the stick displays to show updated circularity data
    this.refresh_finetune_sticks();
  }

  /**
   * Handle slider release - clear circularity data
   * @param {string} lOrR - 'left' or 'right'
   */
  _onCircularitySliderRelease(lOrR) {
    console.log(`Circularity slider released for ${lOrR} stick`);

    // Mark that this slider has been used
    this._sliderUsed[lOrR] = true;

    // Clear the circularity data - zero out the array while maintaining its size
    const config = STICK_CONFIG[lOrR];
    const circData = this[config.circDataName];
    circData.fill(0);

    // Call the clearCircularity function to update the display
    this.clearCircularity();

    // Trigger the change event to update the finetune data once when slider is released
    this._onFinetuneChange();

    // Toggle the slider off and change button to undo
    const stickCard = document.getElementById(`${lOrR}-stick-card`);
    if(stickCard) stickCard.classList.remove('show-slider');
    this._showErrorSlackUndoButton(lOrR);

    // Refresh the stick displays to show cleared circularity data
    this.refresh_finetune_sticks();
  }

  /**
   * Convert circularity data (polar radii) to cartesian coordinates,
   * trim to a -1,-1 to 1,1 square, then convert back to polar radii
   * @param {Array} data - Array of radius values representing sectors around a circle
   */
  _trimCircularityDataToSquare(data) {
    const numSectors = data.length;
    data.forEach((radius, i) => {
      // Calculate angle for this sector
      const angle = (i * 2 * Math.PI) / numSectors;

      // Convert polar to cartesian coordinates
      const x = radius * Math.cos(angle);
      const y = radius * Math.sin(angle);

      // Trim to -1,-1 to 1,1 square
      const trimmedX = Math.max(-1, Math.min(1, x));
      const trimmedY = Math.max(-1, Math.min(1, y));

      // Convert back to polar coordinates
      const trimmedRadius = Math.sqrt(trimmedX * trimmedX + trimmedY * trimmedY);
      data[i] = trimmedRadius;
    });
  }

  /**
   * Reset circularity slider to zero and restore input values to their base state
   * @param {string} lOrR - 'left' or 'right'
   */
  _resetCircularitySlider(lOrR) {
    console.log(`Resetting circularity slider for ${lOrR} stick`);

    // If we have starting values stored, use them to reset properly
    // Reset the slider to zero first
    const slider = document.getElementById(`${lOrR}CircularitySlider`);
    if(slider) slider.value = 0;

    // Trigger the slider change with value 0 to recalculate input values
    this._onCircularitySliderChange(lOrR, 0);

    // Reset the slider used state and update button back to slack
    this._sliderUsed[lOrR] = false;
    this._showErrorSlackButton(lOrR);

    // Clear the circularity data display
    this.clearCircularity();

    // Trigger the change event to update the finetune data
    this._onFinetuneChange();

    // Refresh the stick displays
    this.refresh_finetune_sticks();
  }

  /**
   * Check if data array contains only non-zero values
   * @param {Array} data - The data array to check
   * @returns {boolean} True if all values are non-zero, false otherwise
   */
  _hasOnlyNonZeroValues(data) {
    if (!data || !Array.isArray(data)) {
      return false;
    }
    return data.every(value => value !== 0);
  }

  /**
   * Update the state of error slack buttons based on data content
   */
  _updateErrorSlackButtonStates() {
    Object.entries(STICK_CONFIG).forEach(([lOrR, config]) => {
      if (this._sliderUsed[lOrR]) {
        // Show undo button, hide slack button
        this._showErrorSlackUndoButton(lOrR);
      } else {
        // Show slack button, hide undo button
        this._showErrorSlackButton(lOrR);

        const hasData = this._hasOnlyNonZeroValues(this[config.circDataName]);
        const slackBtn = document.getElementById(`${lOrR}ErrorSlackBtn`);
        if (slackBtn) {
            slackBtn.disabled = !hasData;
            if (hasData) {
                slackBtn.classList.add('btn-secondary');
                slackBtn.classList.remove('btn-outline-secondary');
            } else {
                slackBtn.classList.remove('btn-secondary');
                slackBtn.classList.add('btn-outline-secondary');
            }
        }
      }
    });
  }

  /**
   * Handle error slack button click
   * @param {string} lOrR - 'left' or 'right'
   */
  _onErrorSlackButtonClick(lOrR) {
    console.log(`Error slack button clicked for ${lOrR} stick`);

    // Only allow toggle in circularity mode
    if (this._mode !== 'circularity') {
      console.log('Error slack button only works in circularity mode');
      return;
    }

    // Toggle between showing LX/LY values and circularity slider
    const stickCard = document.getElementById(`${lOrR}-stick-card`);
    if(stickCard) stickCard.classList.toggle('show-slider');
  }

  /**
   * Handle error slack undo button click
   * @param {string} lOrR - 'left' or 'right'
   */
  _onErrorSlackUndoButtonClick(lOrR) {
    console.log(`Error slack undo button clicked for ${lOrR} stick`);

    this._resetCircularitySlider(lOrR);
  }

  /**
   * Toggle button visibility between slack and undo buttons
   * @param {string} lOrR - 'left' or 'right'
   * @param {boolean} showUndo - true to show undo button, false to show slack button
   */
  _toggleErrorSlackButtons(lOrR, showUndo) {
    const undoBtn = document.getElementById(`${lOrR}ErrorSlackUndoBtn`);
    const slackBtn = document.getElementById(`${lOrR}ErrorSlackBtn`);

    if (undoBtn) {
        if (!showUndo) undoBtn.classList.add('d-none');
        else undoBtn.classList.remove('d-none');
    }
    
    if (slackBtn) {
        if (showUndo) slackBtn.classList.add('d-none');
        else slackBtn.classList.remove('d-none');
    }
  }

  /**
   * Show undo button and hide slack button
   * @param {string} lOrR - 'left' or 'right'
   */
  _showErrorSlackUndoButton(lOrR) {
    this._toggleErrorSlackButtons(lOrR, true);
  }

  /**
   * Show slack button and hide undo button
   * @param {string} lOrR - 'left' or 'right'
   */
  _showErrorSlackButton(lOrR) {
    this._toggleErrorSlackButtons(lOrR, false);
  }
}

// Global reference to the current finetune instance
let currentFinetuneInstance = null;

/**
 * Helper function to safely clear the current finetune instance
 */
function destroyCurrentInstance() {
  if (currentFinetuneInstance) {
    currentFinetuneInstance.stopContinuousDpadAdjustment();
    currentFinetuneInstance.removeEventListeners();
    currentFinetuneInstance = null;
  }
}

// Function to create and initialize finetune instance
export async function ds5_finetune(controller, dependencies, doneCallback = null) {
  // Create new instance
  currentFinetuneInstance = new Finetune();
  await currentFinetuneInstance.init(controller, dependencies, doneCallback);
}

export function finetune_handle_controller_input(changes) {
  if (currentFinetuneInstance) {
    currentFinetuneInstance.refresh_finetune_sticks();
    currentFinetuneInstance.handleModeSwitching(changes);
    currentFinetuneInstance.handleStickSwitching(changes);
    currentFinetuneInstance.handleDpadAdjustment(changes);
  }
}

function finetune_save() {
  console.log("Saving finetune changes");
  if (currentFinetuneInstance) {
    currentFinetuneInstance.save();
  }
}

async function finetune_cancel() {
  console.log("Cancelling finetune changes");
  if (currentFinetuneInstance) {
    await currentFinetuneInstance.cancel();
  }
}

export function isFinetuneVisible() {
  return !!currentFinetuneInstance;
}

// Quick calibrate functions
async function finetune_quick_calibrate_center() {
  // Hide the finetune modal
  currentFinetuneInstance.setQuickCalibrating(true);

  const { controller } = currentFinetuneInstance;
  await auto_calibrate_stick_centers(controller, (success, message) => {
    currentFinetuneInstance.setQuickCalibrating(false);
  });
}

async function finetune_quick_calibrate_range() {
  // Hide the finetune modal
  currentFinetuneInstance.setQuickCalibrating(true);

  const { controller, ll_data, rr_data } = currentFinetuneInstance;
  await calibrate_range(controller, { ll_data, rr_data }, (success, message) => {
    currentFinetuneInstance.setQuickCalibrating(false);
  });
}

window.finetune_cancel = finetune_cancel;
window.finetune_save = finetune_save;
window.finetune_quick_calibrate_center = finetune_quick_calibrate_center;
window.finetune_quick_calibrate_range = finetune_quick_calibrate_range;