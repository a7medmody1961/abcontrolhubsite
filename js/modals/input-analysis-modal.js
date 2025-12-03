'use strict';

import { l } from '../translations.js';

/**
 * Input Analysis Modal Class
 * Handles polling rate, latency, and jitter measurement
 */
export class InputAnalysisModal {
    constructor(controllerInstance) {
        this.controller = controllerInstance;
        this.isRunning = false;
        this.intervals = [];
        this.maxSamples = 500; // Keep last 500 samples for stats
        this.animationFrameId = null;
        
        // Canvas setup
        this.canvas = document.getElementById('analysisCanvas');
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
        
        // Stats
        this.lastTimestamp = 0;
        this.maxRate = 0;
    }

    open() {
        const modalEl = document.getElementById('inputAnalysisModal');
        if(modalEl) {
            const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
            modal.show();
        }
        
        // Reset stats UI
        this.resetStats();
        this.renderGraph(); // Clear graph
    }

    close() {
        this.stop();
        const modalEl = document.getElementById('inputAnalysisModal');
        if(modalEl) {
            const modal = bootstrap.Modal.getInstance(modalEl);
            if (modal) modal.hide();
        }
    }

    toggle() {
        if (this.isRunning) {
            this.stop();
        } else {
            this.start();
        }
    }

    start() {
        this.isRunning = true;
        this.resetStats();
        
        // Update UI Button
        const btn = document.getElementById('btn-start-analysis');
        const btnText = document.getElementById('btn-analysis-text');
        if (btn) {
            btn.classList.remove('btn-glow-primary');
            btn.classList.add('btn-glow-danger');
            if(btnText) btnText.textContent = l('Stop Test');
            else btn.innerHTML = `<i class="fas fa-stop me-2"></i> ${l('Stop Test')}`;
        }
        
        const overlay = document.getElementById('analysis-overlay');
        if (overlay) overlay.style.display = 'none';

        // Start animation loop
        this._animate();
    }

    stop() {
        this.isRunning = false;
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }

        // Update UI Button
        const btn = document.getElementById('btn-start-analysis');
        const btnText = document.getElementById('btn-analysis-text');
        if (btn) {
            btn.classList.remove('btn-glow-danger');
            btn.classList.add('btn-glow-primary');
            if(btnText) btnText.textContent = l('Start Test');
            else btn.innerHTML = `<i class="fas fa-play me-2"></i> ${l('Start Test')}`;
        }
    }

    resetStats() {
        this.intervals = [];
        this.lastTimestamp = 0;
        this.maxRate = 0;
        
        // Reset DOM elements
        const els = {
            rate: document.getElementById('stat-polling-rate'),
            max: document.getElementById('stat-max-rate'),
            lat: document.getElementById('stat-latency'),
            jit: document.getElementById('stat-jitter')
        };

        if(els.rate) els.rate.innerText = "0 Hz";
        if(els.max) els.max.innerText = "0";
        if(els.lat) els.lat.innerText = "0.00 ms";
        if(els.jit) els.jit.innerText = "0.00 ms";
    }

    handleInput(timestamp) {
        if (!this.isRunning) return;

        // If it's the first sample
        if (this.lastTimestamp === 0) {
            this.lastTimestamp = timestamp;
            return;
        }

        const interval = timestamp - this.lastTimestamp;
        this.lastTimestamp = timestamp;

        // Ignore unrealistically large gaps (e.g. tab switching)
        if (interval > 1000) return;

        this.intervals.push(interval);
        if (this.intervals.length > this.maxSamples) {
            this.intervals.shift();
        }
    }

    _animate() {
        if (!this.isRunning) return;

        this.updateStats();
        this.renderGraph();

        this.animationFrameId = requestAnimationFrame(() => this._animate());
    }

    updateStats() {
        if (this.intervals.length < 10) return;

        // Use last N samples for "Live" stats to be responsive
        const windowSize = Math.min(this.intervals.length, 100);
        const recentIntervals = this.intervals.slice(-windowSize);
        
        // Average Interval (Latency)
        const sum = recentIntervals.reduce((a, b) => a + b, 0);
        const avgInterval = sum / recentIntervals.length;

        // Polling Rate (Hz) = 1000 / avgInterval
        const rate = avgInterval > 0 ? (1000 / avgInterval) : 0;
        if (rate > this.maxRate) this.maxRate = rate;

        // Jitter (Standard Deviation)
        const squareDiffs = recentIntervals.map(val => Math.pow(val - avgInterval, 2));
        const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / recentIntervals.length;
        const jitter = Math.sqrt(avgSquareDiff);

        // Update DOM
        const els = {
            rate: document.getElementById('stat-polling-rate'),
            max: document.getElementById('stat-max-rate'),
            lat: document.getElementById('stat-latency'),
            jit: document.getElementById('stat-jitter')
        };

        if(els.rate) els.rate.innerText = `${Math.round(rate)} Hz`;
        if(els.max) els.max.innerText = `${Math.round(this.maxRate)}`;
        if(els.lat) els.lat.innerText = `${avgInterval.toFixed(2)} ms`;
        if(els.jit) els.jit.innerText = `${jitter.toFixed(3)} ms`;
    }

    renderGraph() {
        if (!this.ctx || !this.canvas) return;

        // Handle resize
        const width = this.canvas.parentElement.clientWidth;
        const height = this.canvas.parentElement.clientHeight;
        
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }

        const ctx = this.ctx;
        ctx.clearRect(0, 0, width, height);

        if (this.intervals.length < 2) return;

        // Graph Style
        ctx.strokeStyle = '#00f0f0'; // glow-cyan
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();

        // Dynamic Y-axis scaling
        // We want to center the graph around the average, but keep some bounds
        const slice = this.intervals.slice(-width/2); // Draw points based on width
        const maxVal = Math.max(...slice);
        const minVal = Math.min(...slice);
        const range = Math.max(maxVal - minVal, 4); // Minimum range of 4ms to prevent flatline zoom-in

        const stepX = width / (slice.length - 1);

        slice.forEach((val, index) => {
            const x = index * stepX;
            // Map value to Y height (inverted because canvas Y starts at top)
            // Padding: 10% top/bottom
            const padding = height * 0.1;
            const availableHeight = height - (2 * padding);
            const normalizedY = (val - minVal) / range;
            const y = height - padding - (normalizedY * availableHeight);

            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });

        ctx.stroke();
        
        // Draw Average Line
        // const avg = slice.reduce((a,b)=>a+b,0)/slice.length;
        // const avgY = height - (height * 0.1) - (((avg - minVal) / range) * (height * 0.8));
        // ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        // ctx.beginPath();
        // ctx.moveTo(0, avgY);
        // ctx.lineTo(width, avgY);
        // ctx.stroke();
    }
}

// Global Instance Management
let currentAnalysisInstance = null;

export function show_input_analysis_modal(controller) {
    if (!currentAnalysisInstance) {
        currentAnalysisInstance = new InputAnalysisModal(controller);
    }
    currentAnalysisInstance.open();
}

export function toggle_input_analysis() {
    if (currentAnalysisInstance) {
        currentAnalysisInstance.toggle();
    }
}

export function stop_input_analysis() {
    if (currentAnalysisInstance) {
        currentAnalysisInstance.stop();
    }
}

export function isInputAnalysisVisible() {
    // Check if modal is open (bootstrap class 'show')
    const el = document.getElementById('inputAnalysisModal');
    return el && el.classList.contains('show');
}

export function input_analysis_handle_input(timestamp) {
    if (currentAnalysisInstance) {
        currentAnalysisInstance.handleInput(timestamp);
    }
}