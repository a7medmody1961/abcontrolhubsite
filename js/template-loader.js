'use strict';

/**
 * Template Loader
 * Handles loading of HTML templates and SVG assets.
 * Refactored to Vanilla JS (ES6+) with parallel loading optimization.
 */

// Cache for loaded templates
const templateCache = new Map();

/**
* Load a template from the templates directory or bundled assets
* @param {string} templateName - Name of the template file without extension
* @returns {Promise<string>} - Promise that resolves with the template HTML
*/
async function loadTemplate(templateName) {
  // Check if template is already in cache
  if (templateCache.has(templateName)) {
    return templateCache.get(templateName);
  }

  // Check if we have bundled assets (production mode)
  if (window.BUNDLED_ASSETS && window.BUNDLED_ASSETS.templates) {
    const templateHtml = window.BUNDLED_ASSETS.templates[templateName];
    if (templateHtml) {
      templateCache.set(templateName, templateHtml);
      return templateHtml;
    }
  }

  // Fallback to fetching from server (development mode)
  const hasExtension = templateName.includes('.');
  const templatePath = hasExtension ? `templates/${templateName}` : `templates/${templateName}.html`;

  try {
    const response = await fetch(templatePath);
    if (!response.ok) {
      throw new Error(`Failed to load template: ${templateName} (${response.status})`);
    }

    const templateHtml = await response.text();
    templateCache.set(templateName, templateHtml);
    return templateHtml;
  } catch (error) {
    console.error(error);
    throw error;
  }
}

/**
* Load SVG assets from bundled assets or server
* @param {string} assetPath - Path to the SVG asset
* @returns {Promise<string>} - Promise that resolves with the SVG content
*/
async function loadSvgAsset(assetPath) {
  // Check if we have bundled assets (production mode)
  if (window.BUNDLED_ASSETS && window.BUNDLED_ASSETS.svg) {
    const svgContent = window.BUNDLED_ASSETS.svg[assetPath];
    if (svgContent) {
      return svgContent;
    }
  }

  // Fallback to fetching from server (development mode)
  try {
    const response = await fetch(`assets/${assetPath}`);
    if (!response.ok) {
      throw new Error(`Failed to load SVG asset: ${assetPath} (${response.status})`);
    }

    return await response.text();
  } catch (error) {
    console.error(error);
    throw error;
  }
}

/**
* Load all templates and insert them into the DOM
*/
export async function loadAllTemplates() {
  try {
    // Load SVG icons
    const iconsHtml = await loadSvgAsset('icons.svg');
    const iconsContainer = document.createElement('div');
    iconsContainer.innerHTML = iconsHtml;
    document.body.prepend(iconsContainer);

    // Load modals
    // Optimization: Load all modals in parallel instead of sequentially
    const modalNames = [
      'faq-modal',
      'popup-modal',
      'finetune-modal',
      'calib-center-modal',
      'auto-calib-center-modal',
      'range-modal',
      'edge-progress-modal',
      'edge-modal',
      'input-analysis-modal' // <-- New Template Added Here
    ];

    // Create an array of promises
    const modalPromises = modalNames.map(name => loadTemplate(name));
    
    // Wait for all templates to load
    const modalsHtml = await Promise.all(modalPromises);

    // Create modals container and insert all HTML at once
    const modalsContainer = document.createElement('div');
    modalsContainer.id = 'modals-container';
    modalsContainer.innerHTML = modalsHtml.join('');
    
    document.body.appendChild(modalsContainer);
  } catch (error) {
    console.error("Error loading templates:", error);
  }
}