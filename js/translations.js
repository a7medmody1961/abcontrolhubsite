'use strict';

import { la, createCookie, readCookie } from './utils.js';

// Alphabetical order
const available_langs = {
  "ar_ar": { "name": "العربية", "file": "ar_ar.json", "direction": "rtl"},
  "en_us": { "name": "English", "file": "en_us.json", "direction": "ltr"}
};

// Translation state - will be imported from core.js app object
let translationState = null;
let welcomeModal = null;
let handleLanguageChange = null;

export function lang_init(appState, handleLanguageChangeCb, welcomeModalCb) {
  translationState = appState;
  handleLanguageChange = handleLanguageChangeCb;
  welcomeModal = welcomeModalCb;
  
  let id_iter = 0;
  // Replaced jQuery selector with native querySelectorAll
  const items = document.querySelectorAll('.ds-i18n');
  for(const item of items) {
    if (item.id.length === 0) {
      item.id = `ds-i18n-${id_iter++}`;
    }
    
    translationState.lang_orig_text[item.id] = item.innerHTML;
  }
  translationState.lang_orig_text[".title"] = document.title;
  
  // Check URL parameters for language first
  const urlParams = new URLSearchParams(window.location.search);
  const langFromUrl = urlParams.get('lang');
  const force_lang = readCookie("force_lang");

  if (langFromUrl && available_langs[langFromUrl]) {
     lang_set(langFromUrl, true).catch(error => {
      console.error("Failed to set language from URL:", error);
    });
  } else if (force_lang != null) {
    lang_set(force_lang, true).catch(error => {
      console.error("Failed to set forced language:", error);
    });
  } else {
    const nlang = navigator.language.replace('-', '_').toLowerCase();
    const ljson = available_langs[nlang];
    if(ljson) {
      la("lang_init", {"l": nlang});
      lang_translate(ljson["file"], nlang, ljson["direction"]).catch(error => {
        console.error("Failed to load initial language:", error);
      });
    }
  }
}

async function lang_set(lang, skip_modal=false) {
  la("lang_set", { l: lang });
  
  lang_reset_page();
  if(lang !== "en_us") {
    const { file, direction } = available_langs[lang];
    await lang_translate(file, lang, direction);
  }
  
  if (handleLanguageChange) await handleLanguageChange(lang);
  createCookie("force_lang", lang);

  // Update URL without reloading page
  const url = new URL(window.location);
  if (lang === 'ar_ar') {
      url.searchParams.set('lang', 'ar_ar');
  } else {
      url.searchParams.delete('lang');
  }
  window.history.pushState({}, '', url);

  if(!skip_modal && welcomeModal) {
    createCookie("welcome_accepted", "0");
    welcomeModal();
  }
}

export function toggle_lang() {
  const currentLang = readCookie("force_lang") || "en_us";
  const newLang = (currentLang === "en_us") ? "ar_ar" : "en_us";
  lang_set(newLang, true);
}

function lang_reset_page() {
  lang_set_direction("ltr", "en_us");

  // Reset translation state to disable translations
  translationState.lang_cur = {};
  translationState.lang_disabled = true;

  const { lang_orig_text } = translationState;
  const items = document.querySelectorAll('.ds-i18n');
  for(const item of items) {
    if (lang_orig_text[item.id]) {
      item.innerHTML = lang_orig_text[item.id];
    }
  }
  
  const curLangEl = document.getElementById("curLang");
  if(curLangEl) curLangEl.innerHTML = "English";
  
  document.title = lang_orig_text[".title"];
}

function lang_set_direction(new_direction, lang_name) {
  const lang_prefix = lang_name.split("_")[0];
  document.documentElement.setAttribute("lang", lang_prefix);

  if(new_direction == translationState.lang_cur_direction)
    return;

  const bootstrapCss = document.getElementById('bootstrap-css');
  if (bootstrapCss) {
    if(new_direction == "rtl") {
      bootstrapCss.setAttribute('integrity', 'sha384-dpuaG1suU0eT09tx5plTaGMLBsfDLzUCCUXOY2j/LSvXYuG6Bqs43ALlhIqAJVRb');
      bootstrapCss.setAttribute('href', 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.rtl.min.css');
    } else {
      bootstrapCss.setAttribute('integrity', 'sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH');
      bootstrapCss.setAttribute('href', 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css');
    }
  }
  document.documentElement.setAttribute("dir", new_direction);
  translationState.lang_cur_direction = new_direction;
}

export function l(text) {
  if(!translationState || translationState.lang_disabled)
    return text;

  const val = translationState.lang_cur[text];
  // Handle cases where value might be array (legacy) or string
  const out = Array.isArray(val) ? val[0] : val;
  
  if(out) return out;
  
  console.log(`Missing translation for "${text}"`);
  return text;
}

async function lang_translate(target_file, target_lang, target_direction) {
  try {
    // Replaced $.getJSON with fetch
    const response = await fetch("lang/" + target_file);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();

    const { lang_orig_text, lang_cur } = translationState;
    lang_set_direction(target_direction, target_lang);

    // Replaced $.each with Object.entries().forEach
    Object.entries(data).forEach(([key, val]) => {
      if(lang_cur[key]) {
        console.log("Warn: already exists " + key);
      } else {
        // Keep array structure for compatibility
        lang_cur[key] = [val];
      }
    });

    if(Object.keys(lang_cur).length > 0) {
      translationState.lang_disabled = false;
    }

    const items = document.querySelectorAll('.ds-i18n');
    for(const item of items) {
      const originalText = lang_orig_text[item.id];
      const translationEntry = lang_cur[originalText];
      const translatedText = Array.isArray(translationEntry) ? translationEntry[0] : translationEntry;
      
      if (translatedText) {
        item.innerHTML = translatedText;
      } else {
        console.log(`Cannot find mapping for "${originalText}"`);
        if(originalText) item.innerHTML = originalText;
      }
    }

    const old_title = lang_orig_text[".title"];
    const titleEntry = lang_cur[old_title];
    const translatedTitle = Array.isArray(titleEntry) ? titleEntry[0] : titleEntry;
    
    if (translatedTitle) {
         document.title = translatedTitle;
    }

    const curLangEl = document.getElementById("curLang");
    if(curLangEl) curLangEl.innerHTML = available_langs[target_lang]["name"];

  } catch (error) {
    console.error("Failed to load translation file:", target_file, error);
    throw error;
  }
}

// Make lang_set available globally for onclick handlers in HTML
window.lang_set = lang_set;
window.toggle_lang = toggle_lang;