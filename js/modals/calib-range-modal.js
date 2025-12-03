'use strict';

import { sleep } from '../utils.js';
import { l } from '../translations.js';
import { CIRCULARITY_DATA_SIZE } from '../stick-renderer.js';

const SECONDS_UNTIL_UNLOCK = 15;

/**
 * Calibrate Stick Range Modal Class
 * Handles stick range calibration
 * Refactored to Vanilla JS (ES6+)
 */
export class CalibRangeModal {
  constructor(controllerInstance, { ll_data, rr_data }, doneCallback = null) {
    // Dependencies
    this.controller = controllerInstance;
    this.ll_data = ll_data;
    this.rr_data = rr_data;

    // Progress tracking
    this.buttonText = l("Done");
    this.leftNonZeroCount = 0;
    this.rightNonZeroCount = 0;
    this.leftFullCycles = 0;
    this.rightFullCycles = 0;
    this.requiredFullCycles = 4;
    this.progressUpdateInterval = null;

    // Countdown timer
    this.countdownSeconds = 0;
    this.countdownInterval = null;

    // Progress alert enhancement
    this.leftCycleProgress = 0;
    this.rightCycleProgress = 0;

    this.allDonePromiseResolve = undefined;
    this.doneCallback = doneCallback;
  }

  async open() {
    if(!this.controller.isConnected())
      return;

    const alertEl = document.getElementById('range-calibration-alert');
    if (alertEl) alertEl.style.display = 'none';

    const keepRotatingAlert = document.getElementById('keep-rotating-alert');
    if (keepRotatingAlert) keepRotatingAlert.classList.remove('blink-text');

    const doneBtn = document.getElementById('range-done-btn');
    if (doneBtn) {
        doneBtn.disabled = true;
        doneBtn.classList.remove('btn-primary');
        doneBtn.classList.add('btn-outline-primary');
    }

    const modalEl = document.getElementById('rangeModal');
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();

    this.ll_data.fill(0);
    this.rr_data.fill(0);

    this.updateProgress();  // reset progress bar
    this.startProgressMonitoring();

    this.resetAlertEnhancement();
    this.startCountdown();

    await sleep(1000);
    await this.controller.calibrateRangeBegin();
  }

  async onClose() {
    this.stopProgressMonitoring();
    this.stopCountdown();

    const modalEl = document.getElementById('rangeModal');
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.hide();

    const result = await this.controller.calibrateRangeOnClose();

    // Call the done callback if provided
    if (this.doneCallback && typeof this.doneCallback === 'function') {
      this.doneCallback(true, result?.message);
    }
    if (this.allDonePromiseResolve) {
        this.allDonePromiseResolve();
    }
  }

  /**
   * Start monitoring progress by checking ll_data and rr_data arrays
   */
  startProgressMonitoring() {
    this.progressUpdateInterval = setInterval(() => {
      this.checkDataProgress();
    }, 100); // Check every 100ms
  }

  /**
   * Stop progress monitoring
   */
  stopProgressMonitoring() {
    if (this.progressUpdateInterval) {
      clearInterval(this.progressUpdateInterval);
      this.progressUpdateInterval = null;
    }
  }

  /**
   * Start countdown timer for Done button
   */
  startCountdown() {
    this.countdownSeconds = SECONDS_UNTIL_UNLOCK;
    this.updateCountdownButton();

    // Every second, update countdown
    this.countdownInterval = setInterval(() => {
      this.countdownSeconds--;
      if (this.countdownSeconds <= 0 || this.leftCycleProgress + this.rightCycleProgress >= 100) {
        this.stopCountdown();

        const alertEl = document.getElementById('range-calibration-alert');
        if (alertEl) alertEl.style.display = 'none';

        const doneBtn = document.getElementById('range-done-btn');
        if (doneBtn) {
            doneBtn.disabled = false;
            doneBtn.classList.add('btn-primary');
            doneBtn.classList.remove('btn-outline-primary');
        }

        this.updateCountdownButton();
      } else {
        this.checkAndEnhanceAlert();
      }
      this.updateCountdownButton();
    }, 1000);
  }

  /**
   * Stop countdown timer
   */
  stopCountdown() {
    if (!this.countdownInterval) return;

    clearInterval(this.countdownInterval);
    this.countdownInterval = null;
    this.countdownSeconds = 0;
    this.updateCountdownButton();
  }

  /**
   * Update countdown button text and state
   */
  updateCountdownButton() {
    const seconds = this.countdownSeconds;
    const text = this.buttonText + (seconds > 0 ? ` (${seconds})` : "");
    const doneBtn = document.getElementById('range-done-btn');
    if (doneBtn) doneBtn.textContent = text;
  }

  /**
   * Check if ll_data and rr_data have received data
   */
  checkDataProgress() {
    const JOYSTICK_EXTREME_THRESHOLD = 0.95;
    const CIRCLE_FILL_THRESHOLD = 0.95;

    // Count the number of times the joysticks have been rotated full circle
    const leftNonZeroCount = this.ll_data.filter(v => v > JOYSTICK_EXTREME_THRESHOLD).length
    const leftFillRatio = leftNonZeroCount / CIRCULARITY_DATA_SIZE;
    if (leftFillRatio >= CIRCLE_FILL_THRESHOLD) {
      this.leftFullCycles++;
      this.ll_data.fill(0);
    }

    const rightNonZeroCount = this.rr_data.filter(v => v > JOYSTICK_EXTREME_THRESHOLD).length;
    const rightFillRatio = rightNonZeroCount / CIRCULARITY_DATA_SIZE;
    if (rightFillRatio >= CIRCLE_FILL_THRESHOLD) {
      this.rightFullCycles++;
      this.rr_data.fill(0);
    }

    // Update progress if counts changed
    if (leftNonZeroCount !== this.leftNonZeroCount || rightNonZeroCount !== this.rightNonZeroCount) {
      this.leftNonZeroCount = leftNonZeroCount;
      this.rightNonZeroCount = rightNonZeroCount;
      this.updateProgress();
    }
  }

  /**
   * Update the progress bar and enable/disable Done button
   */
  updateProgress() {
    // Calculate progress based on full cycles completed
    const leftCycleProgress = Math.min(1, this.leftFullCycles / this.requiredFullCycles) * 50;
    const rightCycleProgress = Math.min(1, this.rightFullCycles / this.requiredFullCycles) * 50;
    this.leftCycleProgress = leftCycleProgress;
    this.rightCycleProgress = rightCycleProgress;

    // Add current partial progress for visual feedback
    const leftCurrentProgress = (this.leftNonZeroCount / CIRCULARITY_DATA_SIZE) * (50 / this.requiredFullCycles);
    const rightCurrentProgress = (this.rightNonZeroCount / CIRCULARITY_DATA_SIZE) * (50 / this.requiredFullCycles);

    const totalProgress = Math.round(
      Math.min(50, leftCycleProgress + leftCurrentProgress) +
      Math.min(50, rightCycleProgress  + rightCurrentProgress)
    );

    const progressBar = document.getElementById('range-progress-bar');
    if (progressBar) {
        progressBar.style.width = `${totalProgress}%`;
        progressBar.setAttribute('aria-valuenow', totalProgress);
        // Update text inside the progress bar if needed (optional)
        // progressBar.textContent = `${totalProgress}%`; 
    }
  }

  checkAndEnhanceAlert() {
    const secondsElapsed = SECONDS_UNTIL_UNLOCK - this.countdownSeconds;

    const alertEl = document.getElementById('range-calibration-alert');
    // Check if element is visible (offsetParent is null if display: none)
    const alertIsVisible = alertEl && alertEl.offsetParent !== null;
    
    const progressBelowThreshold = this.leftCycleProgress < 10 || this.rightCycleProgress < 10;
    if (secondsElapsed >= 5 && progressBelowThreshold && !alertIsVisible) {
      if (alertEl) alertEl.style.display = 'block';
    }

    const keepRotatingAlert = document.getElementById('keep-rotating-alert');
    if (keepRotatingAlert) {
        const isBlinking = keepRotatingAlert.classList.contains('blink-text');
        if (secondsElapsed >= 7 && progressBelowThreshold && !isBlinking) {
            keepRotatingAlert.classList.add('blink-text');
        }
    }
  }

  resetAlertEnhancement() {
    const el = document.getElementById('keep-rotating-alert');
    if (el) el.classList.remove('blink-text');
  }
}

// Global reference to the current range calibration instance
let currentCalibRangeInstance = null;

function destroyCurrentInstance() {
  currentCalibRangeInstance = null;
}

export async function calibrate_range(controller, dependencies, doneCallback = null) {
  destroyCurrentInstance(); // Clean up any existing instance
  currentCalibRangeInstance = new CalibRangeModal(controller, dependencies, doneCallback);

  await currentCalibRangeInstance.open();
  return new Promise((resolve) => {
    currentCalibRangeInstance.allDonePromiseResolve = resolve;
  });
}

async function calibrate_range_on_close() {
  if (currentCalibRangeInstance) {
    await currentCalibRangeInstance.onClose();
    destroyCurrentInstance();
  }
}

// Expose functions to window for HTML onclick handlers
window.calibrate_range_on_close = calibrate_range_on_close;