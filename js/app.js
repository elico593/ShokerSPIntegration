(function () {
  'use strict';

  // ============================================
  // Constants
  // ============================================
  var WEBHOOK_URL = 'https://hook.eu1.make.com/9jkw4vo5taer3ewajbu6t1c5tvrkgs2k';
  var ROOT_NAME = 'תיקים לבקרה';
  var CREATE_FOLDER_WEBHOOK = 'https://hook.eu1.make.com/ryl1lrkm2tb9re6kgbdh1frud3ityhqy';
  var UPLOAD_WEBHOOK = 'https://hook.eu1.make.com/a9rz1tlo9t4q6ki8nlrx1qpr4teafimb';
  var RENAME_WEBHOOK = 'https://hook.eu1.make.com/qf04b4h7g6is2e66f2hw7aa0gldttb38';
  var DELETE_WEBHOOK = 'https://hook.eu1.make.com/yr8lyulehfnolt02ld682nohv5wzjxm3';
  var THUMBNAIL_WEBHOOK = 'https://hook.eu1.make.com/td8xssina4mri2wal54ulj8wc91clddi';
  var COPY_FILE_WEBHOOK = 'https://hook.eu1.make.com/27ac1v61hgka3lekm4hdulxxug6lrk4v';
  var STORAGE_KEY = 'nisim_saved_location';
  var STORAGE_TTL = 10 * 60 * 60 * 1000; // 10 hours
  var UPLOAD_MAX_BYTES = 3.5 * 1024 * 1024; // ~3.5MB blob → ~4.7MB base64, under 5MB webhook limit

  // Offline queue
  var UPLOAD_TIMEOUT_MS = 20 * 1000;           // 20s per file upload
  var RETRY_DELAY_MS = 60 * 1000;              // 60s between retries
  var MAX_IMMEDIATE_RETRIES = 3;               // 3 immediate retry cycles
  var DEFERRED_RETRY_AFTER_HOURS = 6;          // hours before deferred retries kick in
  var MAX_DEFERRED_RETRIES = 2;               // 2 deferred retry cycles
  var OFFLINE_DB_NAME = 'nisim_offline';
  var OFFLINE_DB_VERSION = 1;
  var OFFLINE_STORE = 'queue';

  // ============================================
  // State
  // ============================================
  var state = {
    breadcrumbs: [],        // [{name, id}]
    currentItems: [],       // folders at current level
    currentFiles: [],       // non-folder items at current level
    filesExpanded: false,   // whether files section is open
    pendingAutoChecks: [],  // ['bikort', 'dochot']
    autoMessages: [],       // accumulated auto-selection messages
    targetFolder: null,     // תמונות folder if found
    searchQuery: '',
    photos: [],           // [{file, name, ext, status, thumbUrl}] — status: pending|uploading|done|error
    uploading: false,
    uploadTargetId: null, // driveItemId of the folder to upload into
    previousVisit: null,  // folder object of detected previous visit for file copy
    filesSort: { key: 'date', dir: 'desc' }, // 'date'|'name', 'asc'|'desc' — reset every page load
  };

  function sortFiles() {
    var key = state.filesSort.key;
    var dir = state.filesSort.dir === 'desc' ? -1 : 1;
    state.currentFiles.sort(function (a, b) {
      var cmp;
      if (key === 'date') {
        var da = a.createdDateTime || '';
        var db = b.createdDateTime || '';
        cmp = da < db ? -1 : da > db ? 1 : 0;
      } else {
        cmp = (a.name || '').localeCompare(b.name || '', 'he', { numeric: true, sensitivity: 'base' });
      }
      return cmp * dir;
    });
  }

  // ============================================
  // DOM References
  // ============================================
  var dom = {
    navBar: document.getElementById('nav-bar'),
    backBtn: document.getElementById('back-btn'),
    breadcrumbs: document.getElementById('breadcrumbs'),
    autoMsg: document.getElementById('auto-msg'),
    searchBox: document.getElementById('search-box'),
    searchInput: document.getElementById('search-input'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    errorText: document.getElementById('error-text'),
    retryBtn: document.getElementById('retry-btn'),
    empty: document.getElementById('empty'),
    folderList: document.getElementById('folder-list'),
    targetFolder: document.getElementById('target-folder'),
    targetPath: document.getElementById('target-path'),
    targetNote: document.getElementById('target-note'),
    createReports: document.getElementById('create-reports'),
    createReportsBtn: document.getElementById('create-reports-btn'),
    reportsCreating: document.getElementById('reports-creating'),
    reportsError: document.getElementById('reports-error'),
    createVisit: document.getElementById('create-visit'),
    createVisitBtn: document.getElementById('create-visit-btn'),
    visitForm: document.getElementById('visit-form'),
    visitName: document.getElementById('visit-name'),
    uploadSection: document.getElementById('upload-section'),
    photoInput: document.getElementById('photo-input'),
    cameraInput: document.getElementById('camera-input'),
    photoList: document.getElementById('photo-list'),
    uploadBtn: document.getElementById('upload-btn'),
    uploadProgress: document.getElementById('upload-progress'),
    progressFill: document.getElementById('progress-fill'),
    progressText: document.getElementById('progress-text'),
    uploadResult: document.getElementById('upload-result'),
    resultText: document.getElementById('result-text'),
    resultCloseBtn: document.getElementById('result-close-btn'),
    confirmVisitBtn: document.getElementById('confirm-visit-btn'),
    visitCreating: document.getElementById('visit-creating'),
    visitError: document.getElementById('visit-error'),
    savedLocation: document.getElementById('saved-location'),
    savedLocationPath: document.getElementById('saved-location-path'),
    savedLocationBtn: document.getElementById('saved-location-btn'),
    savedLocationChange: document.getElementById('saved-location-change'),
    filesSection: document.getElementById('files-section'),
    filesToggle: document.getElementById('files-toggle'),
    filesToggleIcon: document.getElementById('files-toggle-icon'),
    filesToggleText: document.getElementById('files-toggle-text'),
    filesSort: document.getElementById('files-sort'),
    filesSortDate: document.getElementById('files-sort-date'),
    filesSortName: document.getElementById('files-sort-name'),
    fileList: document.getElementById('file-list'),
    visitCopyPrompt: document.getElementById('visit-copy-prompt'),
    copyChoiceNumber: document.getElementById('copy-choice-number'),
    copyChoiceDate: document.getElementById('copy-choice-date'),
    copySkip: document.getElementById('copy-skip'),
  };

  // ============================================
  // API
  // ============================================
  function fetchItems(folderId) {
    return fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderId: folderId }),
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('שגיאת שרת: ' + response.status);
        }
        return response.json();
      })
      .then(function (data) {
        // Handle both raw array and { value: [...] } responses
        var items = Array.isArray(data) ? data : (data.value || []);
        return items;
      });
  }

  function createFolder(parentId, folderName) {
    return fetch(CREATE_FOLDER_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: parentId, folderName: folderName }),
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('שגיאה ביצירת תיקיה: ' + response.status);
        }
        return response.json();
      });
  }

  function resizeImage(file) {
    // Already small enough — send as-is
    if (file.size <= UPLOAD_MAX_BYTES) {
      return Promise.resolve(file);
    }

    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var w = img.width;
        var h = img.height;

        // Android Chrome limits canvas to ~16MP — scale down first if needed
        var MAX_PIXELS = 16000000;
        var pixels = w * h;
        if (pixels > MAX_PIXELS) {
          var pixelScale = Math.sqrt(MAX_PIXELS / pixels);
          w = Math.round(w * pixelScale);
          h = Math.round(h * pixelScale);
        }

        // Step 1: Convert to JPEG, high quality
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);

        canvas.toBlob(function (jpegBlob) {
          if (!jpegBlob) { reject(new Error('שגיאה בעיבוד תמונה')); return; }

          // Step 2: If JPEG conversion alone is enough, done
          if (jpegBlob.size <= UPLOAD_MAX_BYTES) {
            URL.revokeObjectURL(img.src);
            resolve(jpegBlob);
            return;
          }

          // Step 3: Scale dimensions based on JPEG size (not original file size)
          var scale = Math.sqrt(UPLOAD_MAX_BYTES / jpegBlob.size);
          var newW = Math.round(w * scale);
          var newH = Math.round(h * scale);

          canvas.width = newW;
          canvas.height = newH;
          canvas.getContext('2d').drawImage(img, 0, 0, newW, newH);
          URL.revokeObjectURL(img.src);

          // Step 4: Export, reducing quality if still too large
          var quality = 0.92;
          (function tryExport() {
            canvas.toBlob(function (blob) {
              if (!blob) { reject(new Error('שגיאה בעיבוד תמונה')); return; }
              if (blob.size <= UPLOAD_MAX_BYTES || quality <= 0.5) {
                resolve(blob);
              } else {
                quality -= 0.1;
                tryExport();
              }
            }, 'image/jpeg', quality);
          })();
        }, 'image/jpeg', 0.92);
      };
      img.onerror = function () { URL.revokeObjectURL(img.src); reject(new Error('שגיאה בטעינת תמונה')); };
      img.src = URL.createObjectURL(file);
    });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function convertHeicIfNeeded(file) {
    var name = (file.name || '').toLowerCase();
    var isHeic = name.endsWith('.heic') || name.endsWith('.heif') ||
      file.type === 'image/heic' || file.type === 'image/heif';
    if (!isHeic || typeof heic2any === 'undefined') return Promise.resolve(file);
    return heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  }

  function uploadFile(folderId, fileName, file) {
    var _resizedBlob;
    return convertHeicIfNeeded(file)
      .then(function (converted) { return resizeImage(converted); })
      .then(function (resized) {
        _resizedBlob = resized; // capture for offline queuing on failure
        return blobToBase64(resized);
      })
      .then(function (base64Data) {
        var fetchPromise = fetch(UPLOAD_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folderId: folderId,
            fileName: fileName,
            fileData: base64Data,
          }),
        }).then(function (response) {
          if (!response.ok) {
            throw new Error('שגיאה בהעלאת קובץ: ' + response.status);
          }
          return response.json();
        });
        return withTimeout(fetchPromise, UPLOAD_TIMEOUT_MS);
      })
      .catch(function (err) {
        // Attach processed blob so the caller can save it offline
        if (_resizedBlob) err._offlineBlob = _resizedBlob;
        throw err;
      });
  }

  function renameFile(itemId, newName) {
    return fetch(RENAME_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: itemId, newName: newName }),
    })
      .then(function (response) {
        if (!response.ok) {
          if (response.status === 409) throw new Error('שם קובץ כבר קיים');
          throw new Error('שגיאה בשינוי שם: ' + response.status);
        }
        return response.json();
      });
  }

  function deleteFile(itemId) {
    return fetch(DELETE_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: itemId }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('שגיאה במחיקת קובץ: ' + response.status);
        return response.json();
      });
  }

  function fetchThumbnail(itemId) {
    return fetch(THUMBNAIL_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: itemId }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('שגיאה בטעינת תמונה ממוזערת');
        return response.json();
      });
  }

  function copyFile(itemId, targetFolderId, fileName) {
    return fetch(COPY_FILE_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: itemId, targetFolderId: targetFolderId, fileName: fileName }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('שגיאה בהעתקת קובץ: ' + response.status);
        return response.json();
      });
  }

  // ============================================
  // Upload timeout helper
  // ============================================
  function withTimeout(promise, ms) {
    var timer;
    var timeoutPromise = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error('timeout'));
      }, ms);
    });
    return Promise.race([promise, timeoutPromise]).then(
      function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }

  // ============================================
  // Offline Queue (IndexedDB)
  // ============================================
  var _offlineDb = null;
  var _retryTimer = null;

  function openOfflineDb() {
    if (_offlineDb) return Promise.resolve(_offlineDb);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
          db.createObjectStore(OFFLINE_STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = function (e) { _offlineDb = e.target.result; resolve(_offlineDb); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function offlineTx(mode) {
    return openOfflineDb().then(function (db) {
      return db.transaction(OFFLINE_STORE, mode).objectStore(OFFLINE_STORE);
    });
  }

  function addToOfflineQueue(targetFolderId, fileName, blob) {
    return offlineTx('readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        var req = store.add({
          targetFolderId: targetFolderId,
          fileName: fileName,
          blob: blob,
          date: new Date().toDateString(),
          timestamp: Date.now(),
          retryCount: 0,       // 1-3 = immediate retries; 4-5 = deferred retries
          lastAttempt: Date.now(),
        });
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function getOfflineQueue() {
    return offlineTx('readonly').then(function (store) {
      return new Promise(function (resolve, reject) {
        var req = store.getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function removeFromOfflineQueue(id) {
    return offlineTx('readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        var req = store.delete(id);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function updateOfflineRecord(id, updates) {
    return offlineTx('readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        var getReq = store.get(id);
        getReq.onsuccess = function () {
          var rec = getReq.result;
          if (!rec) { resolve(); return; }
          Object.keys(updates).forEach(function (k) { rec[k] = updates[k]; });
          var putReq = store.put(rec);
          putReq.onsuccess = function () { resolve(rec); };
          putReq.onerror = function () { reject(putReq.error); };
        };
        getReq.onerror = function () { reject(getReq.error); };
      });
    });
  }

  // Re-upload a processed blob (already resized/converted) from the offline queue
  function uploadBlob(folderId, fileName, blob) {
    return blobToBase64(blob).then(function (base64Data) {
      var fetchPromise = fetch(UPLOAD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: folderId, fileName: fileName, fileData: base64Data }),
      }).then(function (response) {
        if (!response.ok) throw new Error('שגיאה בהעלאת קובץ: ' + response.status);
        return response.json();
      });
      return withTimeout(fetchPromise, UPLOAD_TIMEOUT_MS);
    });
  }

  // ============================================
  // Offline Queue — Retry engine
  // ============================================
  // Download all queued photos from today to the device.
  // Uses <a download> which works on both iOS (Files app) and Android (Downloads folder).
  function downloadQueuedPhotos() {
    getOfflineQueue().then(function (items) {
      var today = new Date().toDateString();
      var todayItems = items.filter(function (i) { return i.date === today; });
      if (todayItems.length === 0) return;

      // Stagger downloads 600ms apart — browsers block simultaneous programmatic downloads
      todayItems.forEach(function (item, index) {
        setTimeout(function () {
          var url = URL.createObjectURL(item.blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = item.fileName;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
        }, index * 600);
      });
    }).catch(function () {});
  }

  function setDownloadBtnVisible(visible) {
    var btn = document.getElementById('offline-download-btn');
    if (btn) btn.hidden = !visible;
  }

  function showOfflineNotification(type) {
    var banner = document.getElementById('offline-banner');
    var text = document.getElementById('offline-banner-text');
    if (!banner || !text) return;
    if (type === 'deferred') {
      text.textContent = 'התמונות לא הועלו לשרת, ייעשה ניסיון נוסף מאוחר יותר או שתעלה אותם ידנית';
      banner.className = 'offline-banner offline-banner--warning';
      setDownloadBtnVisible(true);
    } else if (type === 'final') {
      text.textContent = 'התמונות מהביקור האחרון לא הועלו לשרת, נא וודא את הכנסתם לתיקייה הרלוונטית בשרת';
      banner.className = 'offline-banner offline-banner--error';
      setDownloadBtnVisible(true);
    } else {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
  }

  function scheduleRetry(delaySecs) {
    if (_retryTimer) clearTimeout(_retryTimer);
    _retryTimer = setTimeout(runRetryBatch, delaySecs);
  }

  function runRetryBatch() {
    _retryTimer = null;
    getOfflineQueue().then(function (items) {
      var today = new Date().toDateString();
      var todayItems = items.filter(function (i) { return i.date === today; });
      if (todayItems.length === 0) return;

      var promises = todayItems.map(function (item) {
        return uploadBlob(item.targetFolderId, item.fileName, item.blob)
          .then(function () {
            return removeFromOfflineQueue(item.id).then(function () {
              return { success: true, item: item };
            });
          })
          .catch(function () {
            return updateOfflineRecord(item.id, {
              retryCount: item.retryCount + 1,
              lastAttempt: Date.now(),
            }).then(function (updated) {
              return { success: false, item: updated || item };
            });
          });
      });

      Promise.all(promises).then(function (results) {
        var failed = results.filter(function (r) { return !r.success; });
        if (failed.length === 0) {
          // All uploaded!
          var banner = document.getElementById('offline-banner');
          if (banner) banner.hidden = true;
          return;
        }

        // *** NEW: Refresh banner count after partial success.
        // Re-read the queue so the displayed number reflects items actually
        // still pending, not the stale count set on app load.
        getOfflineQueue().then(function (remaining) {
          var today = new Date().toDateString();
          var remainingToday = remaining.filter(function (i) { return i.date === today; });
          var bannerText = document.getElementById('offline-banner-text');
          // Only update the count line — don't overwrite 'deferred'/'final' messages
          // which are set separately by showOfflineNotification().
          if (bannerText && remainingToday.length > 0 &&
              !bannerText.textContent.includes('לא הועלו לשרת,')) {
            bannerText.textContent = 'ישנן תמונות שלא הועלו לשרת (' + remainingToday.length + ' קבצים)';
          }
        }).catch(function () {});

        // Determine next action based on max retryCount among failed items
        var maxRetry = Math.max.apply(null, failed.map(function (r) { return r.item.retryCount; }));

        if (maxRetry < MAX_IMMEDIATE_RETRIES) {
          // Still within immediate retries — schedule next in 60s
          scheduleRetry(RETRY_DELAY_MS);
        } else if (maxRetry === MAX_IMMEDIATE_RETRIES) {
          // Just exhausted immediate retries
          showOfflineNotification('deferred');
          // Deferred retries triggered on next app open (see checkDeferredUploads)
        } else if (maxRetry < MAX_IMMEDIATE_RETRIES + MAX_DEFERRED_RETRIES) {
          // Inside deferred retries — schedule next in 60s
          scheduleRetry(RETRY_DELAY_MS);
        } else {
          // All retries exhausted
          showOfflineNotification('final');
        }
      });
    }).catch(function () {
      // DB error — silently ignore
    });
  }

  // Called on app load: if there are pending items from today that exhausted
  // immediate retries, and 6+ hours have passed, kick off deferred retries.
  function checkDeferredUploads() {
    getOfflineQueue().then(function (items) {
      var today = new Date().toDateString();
      var todayItems = items.filter(function (i) { return i.date === today; });
      if (todayItems.length === 0) return;

      // Show persistent banner for pending items
      var banner = document.getElementById('offline-banner');
      var text = document.getElementById('offline-banner-text');
      if (banner && text) {
        text.textContent = 'ישנן תמונות שלא הועלו לשרת (' + todayItems.length + ' קבצים)';
        banner.className = 'offline-banner offline-banner--warning';
        banner.hidden = false;
        // Show download button if immediate retries already exhausted
        var immediateExhausted = todayItems.some(function (i) { return i.retryCount >= MAX_IMMEDIATE_RETRIES; });
        setDownloadBtnVisible(immediateExhausted);
      }

      // Check if ready for deferred retries
      var deferredReady = todayItems.filter(function (i) {
        return i.retryCount >= MAX_IMMEDIATE_RETRIES &&
          i.retryCount < MAX_IMMEDIATE_RETRIES + MAX_DEFERRED_RETRIES;
      });
      if (deferredReady.length === 0) return;

      var lastAttempt = Math.max.apply(null, deferredReady.map(function (i) { return i.lastAttempt; }));
      var hoursSince = (Date.now() - lastAttempt) / (1000 * 60 * 60);
      if (hoursSince >= DEFERRED_RETRY_AFTER_HOURS) {
        runRetryBatch();
      }
    }).catch(function () {});
  }

  // ============================================
  // Location Persistence
  // ============================================
  function saveLocation() {
    var data = {
      breadcrumbs: state.breadcrumbs,
      targetFolder: state.targetFolder,
      targetFolderExists: state.targetFolderExists,
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      // Storage full or unavailable — silently ignore
    }
  }

  function loadSavedLocation() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (Date.now() - data.savedAt > STORAGE_TTL) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return data;
    } catch (e) {
      return null;
    }
  }

  function showSavedLocationCard(saved) {
    var path = saved.breadcrumbs.map(function (b) { return b.name; }).join(' / ');
    var lastCrumb = saved.breadcrumbs[saved.breadcrumbs.length - 1];
    if (saved.targetFolder && saved.targetFolder.name && (!lastCrumb || lastCrumb.name !== saved.targetFolder.name)) {
      path += ' / ' + saved.targetFolder.name;
    }
    dom.savedLocationPath.textContent = path;
    dom.savedLocation.hidden = false;

    // Hide everything else
    dom.navBar.hidden = true;
    dom.searchBox.hidden = true;
    dom.folderList.innerHTML = '';
    dom.loading.hidden = true;
    dom.error.hidden = true;
    dom.empty.hidden = true;
    dom.targetFolder.hidden = true;
    dom.uploadSection.hidden = true;
    dom.createVisit.hidden = true;
    dom.autoMsg.hidden = true;
  }

  function restoreSavedLocation(saved) {
    dom.savedLocation.hidden = true;
    state.breadcrumbs = saved.breadcrumbs;
    state.targetFolder = saved.targetFolder;
    state.targetFolderExists = saved.targetFolderExists;
    state.pendingAutoChecks = [];
    state.autoMessages = [];
    state.searchQuery = '';

    // Fetch the last breadcrumb folder to verify it still exists
    var lastCrumb = state.breadcrumbs[state.breadcrumbs.length - 1];
    fetchAndDisplay(lastCrumb.id);
  }

  // ============================================
  // Navigation
  // ============================================
  function loadRoot() {
    state.breadcrumbs = [{ name: ROOT_NAME, id: 'root' }];
    state.pendingAutoChecks = [];
    state.autoMessages = [];
    state.targetFolder = null;
    state.searchQuery = '';
    dom.searchInput.value = '';

    // Check for saved location
    var saved = loadSavedLocation();
    if (saved && saved.breadcrumbs && saved.breadcrumbs.length > 1) {
      showSavedLocationCard(saved);
      return;
    }

    fetchAndDisplay('root');
  }

  function selectFolder(folderId, folderName) {
    var isProjectSelection = state.breadcrumbs.length === 1;
    state.breadcrumbs.push({ name: folderName, id: folderId });

    if (isProjectSelection) {
      state.pendingAutoChecks = ['bikort', 'dochot'];
      state.autoMessages = [];
    }

    state.skipAutoNav = false;
    state.targetFolder = null;
    state.searchQuery = '';
    dom.searchInput.value = '';
    fetchAndDisplay(folderId);
  }

  function navigateToBreadcrumb(index) {
    if (index >= state.breadcrumbs.length - 1) return;
    var crumb = state.breadcrumbs[index];
    state.breadcrumbs = state.breadcrumbs.slice(0, index + 1);
    state.pendingAutoChecks = [];
    state.autoMessages = [];
    state.skipAutoNav = true;
    state.targetFolder = null;
    state.searchQuery = '';
    dom.searchInput.value = '';
    fetchAndDisplay(crumb.id);
  }

  function fetchAndDisplay(folderId) {
    showLoading(true);
    hideError();
    hideEmpty();
    dom.folderList.innerHTML = '';
    dom.targetFolder.hidden = true;
    dom.uploadSection.hidden = true;
    state.photos.forEach(function (p) { URL.revokeObjectURL(p.thumbUrl); });
    state.photos = [];
    state.uploading = false;
    state.uploadTargetId = null;
    dom.createReports.hidden = true;
    dom.reportsError.hidden = true;
    dom.createVisit.hidden = true;
    dom.visitForm.hidden = true;
    dom.autoMsg.hidden = true;
    dom.filesSection.hidden = true;

    fetchItems(folderId)
      .then(function (items) {
        var folders = items.filter(function (item) { return item.folder; });
        var files = items.filter(function (item) { return !item.folder; });
        state.currentItems = folders;
        state.currentFiles = files;
        sortFiles();
        showLoading(false);
        if (state.breadcrumbs.length > 1) saveLocation();

        // If we're inside a תמונות folder, set it as upload target
        var currentCrumb = state.breadcrumbs[state.breadcrumbs.length - 1];
        var isInPhotosFolder = currentCrumb && currentCrumb.name === 'תמונות';
        state.filesExpanded = folders.length === 0 || isInPhotosFolder; // auto-expand in תמונות or when no subfolders
        if (isInPhotosFolder) {
          state.targetFolder = { name: currentCrumb.name, id: currentCrumb.id };
          state.targetFolderExists = true;
          state.uploadTargetId = currentCrumb.id;
        }

        if (folders.length === 0) {
          // Check if we're inside a visit folder (תמונות will be created on first upload)
          var currentName = currentCrumb ? currentCrumb.name : '';
          if (!state.targetFolder && /(?:דוח\s+)?ביקור\s*[-\s]*(?:מס(?:פר|'?)?\s*[-\s]*)?\d+/.test(currentName)) {
            state.targetFolder = { name: 'תמונות', id: currentCrumb.id, create: true };
            state.targetFolderExists = false;
          }
          showTargetFolder();
          if (files.length === 0 && !state.targetFolder) showEmpty();
          renderBreadcrumbs();
          renderFiles();
          updateSearchVisibility();
          updateCreateVisitVisibility();
          updateCreateReportsVisibility();
          return;
        }

        // Check for תמונות — auto-navigate into it (unless user navigated back)
        var photosFolder = folders.find(function (f) { return f.name === 'תמונות'; });
        if (photosFolder && !state.skipAutoNav) {
          state.breadcrumbs.push({ name: photosFolder.name, id: photosFolder.id });
          fetchAndDisplay(photosFolder.id);
          return;
        } else {
          // Check if we're inside a visit folder (תמונות will be created on first upload)
          var currentName = currentCrumb ? currentCrumb.name : '';
          var isVisitFolder = /(?:דוח\s+)?ביקור\s*[-\s]*(?:מס(?:פר|'?)?\s*[-\s]*)?\d+/.test(currentName);
          if (isVisitFolder) {
            state.targetFolder = { name: 'תמונות', id: currentCrumb.id, create: true };
            state.targetFolderExists = false;
          }
        }

        // Auto-selection cascade
        if (state.pendingAutoChecks.length > 0) {
          var check = state.pendingAutoChecks[0];

          if (check === 'bikort') {
            state.pendingAutoChecks.shift();
            var match = folders.find(function (f) { return f.name === 'בקרת ביצוע'; });
            if (match) {
              state.autoMessages.push('בקרת ביצוע');
              state.breadcrumbs.push({ name: match.name, id: match.id });
              fetchAndDisplay(match.id);
              return;
            }
          }
        }

        // Auto-select דוחות if inside בקרת ביצוע (at any depth) and there's exactly one match
        var insideBikort = state.breadcrumbs.some(function (b) { return b.name === 'בקרת ביצוע'; });
        if (insideBikort && !state.skipAutoNav) {
          var dochotMatches = folders.filter(function (f) { return f.name.startsWith('דוחות'); });
          if (dochotMatches.length === 1) {
            state.autoMessages.push(dochotMatches[0].name);
            state.breadcrumbs.push({ name: dochotMatches[0].name, id: dochotMatches[0].id });
            // Clear the dochot pending check if it's still queued
            var dochotIdx = state.pendingAutoChecks.indexOf('dochot');
            if (dochotIdx !== -1) state.pendingAutoChecks.splice(dochotIdx, 1);
            fetchAndDisplay(dochotMatches[0].id);
            return;
          }
        }
        // Clear dochot from pending if we didn't auto-select
        var dochotIdx = state.pendingAutoChecks.indexOf('dochot');
        if (dochotIdx !== -1) state.pendingAutoChecks.splice(dochotIdx, 1);

        // Show auto-selection notification
        if (state.autoMessages.length > 0) {
          showAutoSelectMsg(state.autoMessages);
          state.autoMessages = [];
        }

        renderBreadcrumbs();
        renderFolders();
        renderFiles();
        updateSearchVisibility();
        showTargetFolder();
        updateCreateVisitVisibility();
        updateCreateReportsVisibility();
      })
      .catch(function (err) {
        showLoading(false);
        showError(err.message || 'שגיאה בטעינת תיקיות');
        renderBreadcrumbs();
      });
  }

  // ============================================
  // Rendering
  // ============================================
  var FILE_ICONS = {
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', bmp: '🖼️', webp: '🖼️', heic: '🖼️',
    pdf: '📄', doc: '📄', docx: '📄', txt: '📄', rtf: '📄',
    xls: '📊', xlsx: '📊', csv: '📊',
    ppt: '📊', pptx: '📊',
    zip: '📦', rar: '📦', '7z': '📦',
  };

  function getFileIcon(fileName) {
    var ext = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
    return FILE_ICONS[ext] || '📄';
  }

  function isImageFile(fileName) {
    var ext = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic'].indexOf(ext) !== -1;
  }

  function renderBreadcrumbs() {
    dom.navBar.hidden = state.breadcrumbs.length <= 1;
    dom.breadcrumbs.innerHTML = '';

    state.breadcrumbs.forEach(function (crumb, index) {
      if (index > 0) {
        var sep = document.createElement('span');
        sep.className = 'breadcrumbs__sep';
        sep.textContent = '/';
        dom.breadcrumbs.appendChild(sep);
      }

      var item = document.createElement('button');
      item.className = 'breadcrumbs__item';
      item.textContent = crumb.name;
      item.type = 'button';

      if (index === state.breadcrumbs.length - 1) {
        item.classList.add('breadcrumbs__item--active');
        item.disabled = true;
      } else {
        (function (i) {
          item.addEventListener('click', function () { navigateToBreadcrumb(i); });
        })(index);
      }

      dom.breadcrumbs.appendChild(item);
    });
  }

  function renderFolders() {
    dom.folderList.innerHTML = '';
    var query = state.searchQuery.trim().toLowerCase();
    var filtered = query
      ? state.currentItems.filter(function (f) { return f.name.toLowerCase().includes(query); })
      : state.currentItems;

    if (filtered.length === 0 && query) {
      var noResults = document.createElement('li');
      noResults.className = 'folder-list__empty';
      noResults.textContent = 'לא נמצאו תוצאות';
      dom.folderList.appendChild(noResults);
      return;
    }

    filtered.forEach(function (folder) {
      var li = document.createElement('li');

      var btn = document.createElement('button');
      btn.className = 'folder-card';
      btn.type = 'button';

      var icon = document.createElement('span');
      icon.className = 'folder-card__icon';
      icon.textContent = '📁';

      var name = document.createElement('span');
      name.className = 'folder-card__name';
      name.textContent = folder.name;

      var count = document.createElement('span');
      count.className = 'folder-card__count';
      if (folder.folder && folder.folder.childCount > 0) {
        count.textContent = folder.folder.childCount + ' פריטים';
      }

      var arrow = document.createElement('span');
      arrow.className = 'folder-card__arrow';
      arrow.textContent = '‹'; // ‹

      btn.appendChild(icon);
      btn.appendChild(name);
      btn.appendChild(count);
      btn.appendChild(arrow);

      (function (f) {
        btn.addEventListener('click', function () { selectFolder(f.id, f.name); });
      })(folder);

      li.appendChild(btn);
      dom.folderList.appendChild(li);
    });
  }

  function renderFiles() {
    if (state.currentFiles.length === 0) {
      dom.filesSection.hidden = true;
      return;
    }

    dom.filesSection.hidden = false;
    dom.filesToggleText.textContent = 'קבצים (' + state.currentFiles.length + ')';
    dom.filesToggleIcon.className = 'files-section__chevron' +
      (state.filesExpanded ? ' files-section__chevron--open' : '');
    dom.fileList.hidden = !state.filesExpanded;
    dom.filesSort.hidden = !state.filesExpanded;
    renderSortButtons();
    dom.fileList.innerHTML = '';

    if (!state.filesExpanded) return;

    var query = state.searchQuery.trim().toLowerCase();

    state.currentFiles.forEach(function (file, index) {
      if (query && !file.name.toLowerCase().includes(query)) return;

      var li = document.createElement('li');
      var card = document.createElement('div');
      card.className = 'file-card';
      card.dataset.index = index;

      // Icon or thumbnail placeholder
      var inPhotosFolder = state.breadcrumbs.length > 0 &&
        state.breadcrumbs[state.breadcrumbs.length - 1].name === 'תמונות';
      if (inPhotosFolder && isImageFile(file.name)) {
        var thumb = document.createElement('img');
        thumb.className = 'file-card__thumb file-card__thumb--loading';
        thumb.alt = '';
        thumb.src = ''; // will be loaded lazily
        thumb.dataset.itemId = file.id;
        card.appendChild(thumb);
      } else {
        var icon = document.createElement('span');
        icon.className = 'file-card__icon';
        icon.textContent = getFileIcon(file.name);
        card.appendChild(icon);
      }

      // Filename
      var name = document.createElement('span');
      name.className = 'file-card__name';
      name.textContent = file.name;
      card.appendChild(name);

      // Action buttons — only for images inside תמונות folders
      if (inPhotosFolder && isImageFile(file.name)) {
        var actions = document.createElement('span');
        actions.className = 'file-card__actions';

        var editBtn = document.createElement('button');
        editBtn.className = 'file-card__action-btn';
        editBtn.type = 'button';
        editBtn.textContent = '✏️';
        editBtn.title = 'שנה שם';
        (function (f, cardEl) {
          editBtn.addEventListener('click', function () { enterEditMode(f, cardEl); });
        })(file, card);

        var deleteBtn = document.createElement('button');
        deleteBtn.className = 'file-card__action-btn file-card__action-btn--danger';
        deleteBtn.type = 'button';
        deleteBtn.textContent = '🗑️';
        deleteBtn.title = 'מחק';
        (function (f, cardEl, idx) {
          deleteBtn.addEventListener('click', function () { enterDeleteMode(f, cardEl, idx); });
        })(file, card, index);

        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
        card.appendChild(actions);
      }

      li.appendChild(card);
      dom.fileList.appendChild(li);
    });

    if (state.filesExpanded) {
      loadThumbnails();
    }
  }

  var thumbnailCache = {}; // { itemId: dataUrl }

  function loadThumbnails() {
    var thumbEls = dom.fileList.querySelectorAll('.file-card__thumb[data-item-id]');
    thumbEls.forEach(function (el) {
      var itemId = el.dataset.itemId;
      if (!itemId) return;

      if (thumbnailCache[itemId]) {
        el.src = thumbnailCache[itemId];
        el.classList.remove('file-card__thumb--loading');
        return;
      }

      fetchThumbnail(itemId)
        .then(function (data) {
          // The thumbnail webhook returns Graph API JSON with a url field
          var src = data.url || ('data:image/jpeg;base64,' + data.base64);
          thumbnailCache[itemId] = src;
          el.src = src;
          el.classList.remove('file-card__thumb--loading');
        })
        .catch(function () {
          // Replace with icon on failure
          var icon = document.createElement('span');
          icon.className = 'file-card__icon';
          icon.textContent = '🖼️';
          el.replaceWith(icon);
        });
    });
  }

  function enterEditMode(file, cardEl) {
    var nameEl = cardEl.querySelector('.file-card__name');
    var actionsEl = cardEl.querySelector('.file-card__actions');

    // Replace name span with input (basename only, no extension)
    var dotIndex = file.name.lastIndexOf('.');
    var baseName = dotIndex > 0 ? file.name.substring(0, dotIndex) : file.name;
    var ext = dotIndex > 0 ? file.name.substring(dotIndex) : '';
    var input = document.createElement('input');
    input.className = 'file-card__edit-input';
    input.type = 'text';
    input.value = baseName;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    // Replace actions with save/cancel
    actionsEl.innerHTML = '';

    var saveBtn = document.createElement('button');
    saveBtn.className = 'file-card__confirm-btn file-card__confirm-btn--yes';
    saveBtn.type = 'button';
    saveBtn.textContent = '✓';
    saveBtn.title = 'שמור';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'file-card__confirm-btn file-card__confirm-btn--no';
    cancelBtn.type = 'button';
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'ביטול';

    actionsEl.appendChild(saveBtn);
    actionsEl.appendChild(cancelBtn);

    cancelBtn.addEventListener('click', function () {
      renderFiles(); // re-render to reset
    });

    saveBtn.addEventListener('click', function () {
      var newBaseName = input.value.trim();
      if (!newBaseName || newBaseName === baseName) {
        renderFiles();
        return;
      }
      var newName = newBaseName + ext;

      // Show spinner
      actionsEl.innerHTML = '';
      var spinner = document.createElement('span');
      spinner.className = 'file-card__spinner';
      actionsEl.appendChild(spinner);
      input.disabled = true;

      renameFile(file.id, newName)
        .then(function () {
          file.name = newName;
          renderFiles();
        })
        .catch(function (err) {
          // Show error inline
          input.disabled = false;
          actionsEl.innerHTML = '';
          actionsEl.appendChild(saveBtn);
          actionsEl.appendChild(cancelBtn);
          var errorEl = document.createElement('div');
          errorEl.className = 'file-card__error';
          errorEl.textContent = err.message;
          cardEl.parentNode.appendChild(errorEl);
          setTimeout(function () { if (errorEl.parentNode) errorEl.parentNode.removeChild(errorEl); }, 3000);
        });
    });
  }

  function enterDeleteMode(file, cardEl, fileIndex) {
    var actionsEl = cardEl.querySelector('.file-card__actions');

    // Replace actions with confirmation
    actionsEl.innerHTML = '';
    var confirm = document.createElement('span');
    confirm.className = 'file-card__confirm';
    confirm.textContent = 'מחיקה?';

    var yesBtn = document.createElement('button');
    yesBtn.className = 'file-card__confirm-btn file-card__confirm-btn--yes';
    yesBtn.type = 'button';
    yesBtn.textContent = '✓';

    var noBtn = document.createElement('button');
    noBtn.className = 'file-card__confirm-btn file-card__confirm-btn--no';
    noBtn.type = 'button';
    noBtn.textContent = '✕';

    actionsEl.appendChild(confirm);
    actionsEl.appendChild(yesBtn);
    actionsEl.appendChild(noBtn);

    noBtn.addEventListener('click', function () {
      renderFiles(); // reset
    });

    yesBtn.addEventListener('click', function () {
      // Show spinner
      actionsEl.innerHTML = '';
      var spinner = document.createElement('span');
      spinner.className = 'file-card__spinner';
      actionsEl.appendChild(spinner);

      deleteFile(file.id)
        .then(function () {
          state.currentFiles.splice(fileIndex, 1);
          renderFiles();
        })
        .catch(function (err) {
          renderFiles(); // reset to normal state
          // Brief error flash on the card
          cardEl.style.borderColor = 'var(--error)';
          setTimeout(function () { cardEl.style.borderColor = ''; }, 2000);
        });
    });
  }

  // ============================================
  // UI Helpers
  // ============================================
  function showLoading(show) {
    dom.loading.hidden = !show;
    if (show) {
      dom.folderList.innerHTML = '';
      dom.empty.hidden = true;
    }
  }

  function showError(message) {
    dom.error.hidden = false;
    dom.errorText.textContent = message;
  }

  function hideError() {
    dom.error.hidden = true;
  }

  function showEmpty() {
    dom.empty.hidden = false;
  }

  function hideEmpty() {
    dom.empty.hidden = true;
  }

  function showAutoSelectMsg(messages) {
    dom.autoMsg.hidden = false;
    dom.autoMsg.textContent = 'נבחר אוטומטית: ' + messages.join(', ');
  }

  function showTargetFolder() {
    if (!state.targetFolder) {
      dom.targetFolder.hidden = true;
      return;
    }
    dom.targetFolder.hidden = false;
    var lastCrumb = state.breadcrumbs[state.breadcrumbs.length - 1];
    var alreadyInPhotos = lastCrumb && lastCrumb.name === 'תמונות';
    var path = state.breadcrumbs.map(function (b) { return b.name; }).join(' / ');
    if (!alreadyInPhotos) path += ' / תמונות';
    dom.targetPath.textContent = path;
    dom.targetNote.textContent = state.targetFolderExists
      ? 'תמונות יועלו לתיקיה זו'
      : 'תיקיית תמונות תיווצר אוטומטית בהעלאה הראשונה';

    // Show upload section when we have a target
    if (state.targetFolder) {
      dom.uploadSection.hidden = false;
      state.uploadTargetId = state.targetFolderExists
        ? state.targetFolder.id
        : null; // will be set after folder creation
    } else {
      dom.uploadSection.hidden = true;
    }
  }

  function updateSearchVisibility() {
    var show = state.breadcrumbs.length === 1 || state.currentItems.length > 15;
    dom.searchBox.hidden = !show;
    if (show) {
      dom.searchInput.placeholder = state.breadcrumbs.length === 1
        ? 'חיפוש פרויקט...'
        : 'חיפוש תיקיה...';
    }
    if (!show) {
      state.searchQuery = '';
      dom.searchInput.value = '';
    }
  }

  function updateCreateVisitVisibility() {
    // Show only inside a reports folder (דוחות), not inside a visit folder
    var currentName = state.breadcrumbs.length > 0
      ? state.breadcrumbs[state.breadcrumbs.length - 1].name
      : '';
    var insideReports = /^דוחות/.test(currentName);
    var show = state.pendingAutoChecks.length === 0 && state.breadcrumbs.length >= 4 && insideReports;
    dom.createVisit.hidden = !show;
    if (show) {
      dom.visitForm.hidden = true;
    }
  }

  function updateCreateReportsVisibility() {
    var currentName = state.breadcrumbs.length > 0
      ? state.breadcrumbs[state.breadcrumbs.length - 1].name
      : '';
    // Show when: deep enough, not in דוחות/visit/תמונות, no דוחות subfolder exists, no pending auto-checks
    var isReportsFolder = /^דוחות/.test(currentName);
    var isVisitFolder = /(?:דוח\s+)?ביקור\s*[-\s]*(?:מס(?:פר|'?)?\s*[-\s]*)?\d+/.test(currentName);
    var isPhotosFolder = currentName === 'תמונות';
    var hasDochot = state.currentItems.some(function (f) { return /^דוחות/.test(f.name); });
    var show = state.pendingAutoChecks.length === 0
      && state.breadcrumbs.length >= 3
      && !isReportsFolder && !isVisitFolder && !isPhotosFolder
      && !hasDochot;
    dom.createReports.hidden = !show;
  }

  // ============================================
  // Create Visit Name
  // ============================================
  function generateVisitName() {
    var visitFolders = state.currentItems.filter(function (f) {
      return f.name.includes('ביקור');
    });

    var maxNum = 0;
    visitFolders.forEach(function (f) {
      var match = f.name.match(/(?:דוח\s+)?ביקור\s*[-\s]*(?:מס(?:פר|'?)?\s*[-\s]*)?(\d+)/);
      if (match) {
        var parsed = parseInt(match[1], 10);
        if (parsed > maxNum) maxNum = parsed;
      }
    });

    var nextNum = maxNum + 1;
    var today = new Date();
    var day = String(today.getDate()).padStart(2, '0');
    var month = String(today.getMonth() + 1).padStart(2, '0');
    var year = today.getFullYear();
    return 'ביקור ' + nextNum + ' ' + day + '-' + month + '-' + year;
  }

  // ============================================
  // Previous Visit Detection & File Copy
  // ============================================
  var VISIT_NUM_REGEX = /(?:דוח\s+)?ביקור\s*[-\s]*(?:מס(?:פר|'?)?\s*[-\s]*)?(\d+)/;
  var DOC_EXTENSIONS = ['docx', 'doc', 'rtf'];

  function findPreviousVisitFolder() {
    var visitFolders = state.currentItems.filter(function (f) {
      return VISIT_NUM_REGEX.test(f.name);
    });
    if (visitFolders.length === 0) return null;

    // By highest visit number
    var byNumber = null;
    var maxNum = 0;
    visitFolders.forEach(function (f) {
      var match = f.name.match(VISIT_NUM_REGEX);
      if (match) {
        var num = parseInt(match[1], 10);
        if (num > maxNum) { maxNum = num; byNumber = f; }
      }
    });

    // By most recent createdDateTime
    var byDate = null;
    var maxDate = '';
    visitFolders.forEach(function (f) {
      var dt = f.createdDateTime || '';
      if (dt > maxDate) { maxDate = dt; byDate = f; }
    });

    if (!byNumber && !byDate) return null;
    if (byNumber && byDate && byNumber.id === byDate.id) {
      return { folder: byNumber, ambiguous: false };
    }
    if (!byNumber) return { folder: byDate, ambiguous: false };
    if (!byDate) return { folder: byNumber, ambiguous: false };
    return { byNumber: byNumber, byDate: byDate, ambiguous: true };
  }

  function getDocFiles(items) {
    return items.filter(function (item) {
      if (item.folder) return false;
      var ext = item.name.substring(item.name.lastIndexOf('.') + 1).toLowerCase();
      return DOC_EXTENSIONS.indexOf(ext) !== -1;
    });
  }

  function copyPreviousVisitFiles(sourceFolderId, targetFolderId, newVisitName) {
    // List files in source visit folder
    return fetchItems(sourceFolderId)
      .then(function (items) {
        var docs = getDocFiles(items);
        if (docs.length === 0) return { copied: [], failed: [] };

        // Copy files sequentially to avoid webhook rate limits
        var copied = [];
        var failed = [];
        var chain = Promise.resolve();
        docs.forEach(function (doc) {
          chain = chain.then(function () {
            return copyFile(doc.id, targetFolderId, doc.name)
              .then(function (result) {
                copied.push({ name: doc.name, id: result.id || null });
              })
              .catch(function (err) {
                failed.push({ name: doc.name, error: err.message });
              });
          });
        });
        return chain.then(function () { return { copied: copied, failed: failed }; });
      });
  }

  function renameReportFiles(copiedFiles, newVisitName, targetFolderId) {
    if (copiedFiles.length === 0) return Promise.resolve();

    var reportRegex = /(?:ביקור|דוח)/;
    var chain = Promise.resolve();
    var renameCount = 0;

    copiedFiles.forEach(function (file) {
      if (!reportRegex.test(file.name) || !file.id) return;
      chain = chain.then(function () {
        var ext = file.name.substring(file.name.lastIndexOf('.'));
        var baseName = newVisitName;
        renameCount++;
        if (renameCount > 1) baseName += ' (' + renameCount + ')';
        var newName = baseName + ext;
        return renameFile(file.id, newName).catch(function () {
          // Rename failure is non-critical
        });
      });
    });
    return chain;
  }

  function showCopyResult(result) {
    if (result.copied.length === 0) return;
    var msg = 'הועתקו ' + result.copied.length + ' קבצים מהביקור הקודם';
    if (result.failed.length > 0) {
      msg += ' (' + result.failed.length + ' נכשלו)';
    }
    dom.autoMsg.textContent = msg;
    dom.autoMsg.hidden = false;
  }

  // ============================================
  // Photo Management
  // ============================================
  function getNextPhotoNumber() {
    var maxNum = 0;
    // Check existing files in folder
    state.currentFiles.forEach(function (f) {
      var match = f.name.match(/^תמונה (\d+)/);
      if (match) {
        var n = parseInt(match[1], 10);
        if (n > maxNum) maxNum = n;
      }
    });
    // Check photos already queued for upload
    state.photos.forEach(function (p) {
      var match = p.name.match(/^תמונה (\d+)$/);
      if (match) {
        var n = parseInt(match[1], 10);
        if (n > maxNum) maxNum = n;
      }
    });
    return maxNum + 1;
  }

  function addPhotos(files) {
    dom.uploadResult.hidden = true;
    var nextNum = getNextPhotoNumber();
    var conversions = [];
    for (var i = 0; i < files.length; i++) {
      (function (file, idx) {
        var ext = file.name.substring(file.name.lastIndexOf('.'));
        var isHeic = /\.(heic|heif)$/i.test(ext);
        var photo = {
          file: file,
          name: 'תמונה ' + (nextNum + idx),
          ext: ext,
          status: isHeic ? 'converting' : 'pending',
          thumbUrl: isHeic ? '' : URL.createObjectURL(file),
        };
        state.photos.push(photo);
        if (isHeic && typeof heic2any !== 'undefined') {
          conversions.push(
            heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 })
              .then(function (jpegBlob) {
                photo.file = jpegBlob;
                photo.ext = '.jpg';
                photo.thumbUrl = URL.createObjectURL(jpegBlob);
                photo.status = 'pending';
                renderPhotos();
                updateUploadBtn();
              })
              .catch(function () {
                photo.thumbUrl = URL.createObjectURL(file);
                photo.status = 'pending';
                renderPhotos();
                updateUploadBtn();
              })
          );
        }
      })(files[i], i);
    }
    renderPhotos();
    updateUploadBtn();
    // Scroll to and highlight the last added photo's name field
    var lastItem = dom.photoList.querySelector('.photo-item:last-child');
    if (lastItem) {
      lastItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      var lastInput = lastItem.querySelector('.photo-item__name');
      if (lastInput) {
        lastInput.classList.remove('photo-item__name--highlight');
        void lastInput.offsetWidth; // force reflow to restart animation
        lastInput.classList.add('photo-item__name--highlight');
      }
    }
  }

  function removePhoto(index) {
    URL.revokeObjectURL(state.photos[index].thumbUrl);
    state.photos.splice(index, 1);
    // Renumber default names
    state.photos.forEach(function (p, i) {
      if (/^תמונה \d+$/.test(p.name)) {
        p.name = 'תמונה ' + (i + 1);
      }
    });
    renderPhotos();
    updateUploadBtn();
  }

  function renderPhotos() {
    dom.photoList.innerHTML = '';
    state.photos.forEach(function (photo, index) {
      var li = document.createElement('li');
      li.className = 'photo-item';
      if (photo.status === 'error') li.className += ' photo-item--error';
      if (photo.status === 'done') li.className += ' photo-item--success';
      if (photo.status === 'converting') li.className += ' photo-item--converting';

      var thumb;
      if (photo.thumbUrl) {
        thumb = document.createElement('img');
        thumb.className = 'photo-item__thumb';
        thumb.src = photo.thumbUrl;
        thumb.alt = '';
      } else {
        thumb = document.createElement('div');
        thumb.className = 'photo-item__thumb photo-item__thumb--loading';
      }

      var nameInput = document.createElement('input');
      nameInput.className = 'photo-item__name';
      nameInput.type = 'text';
      nameInput.value = photo.name;
      nameInput.dir = 'rtl';
      nameInput.disabled = state.uploading;
      (function (idx) {
        nameInput.addEventListener('input', function () {
          state.photos[idx].name = nameInput.value;
          updateUploadBtn();
        });
        nameInput.addEventListener('focus', function () {
          if (/^תמונה \d+$/.test(nameInput.value)) {
            nameInput.select();
          }
        });
      })(index);

      li.appendChild(thumb);
      li.appendChild(nameInput);

      if (state.uploading) {
        var status = document.createElement('span');
        status.className = 'photo-item__status';
        if (photo.status === 'done') status.textContent = '✅';
        else if (photo.status === 'error') status.textContent = '❌';
        else if (photo.status === 'uploading') status.textContent = '⏳';
        li.appendChild(status);
      } else {
        var removeBtn = document.createElement('button');
        removeBtn.className = 'photo-item__remove';
        removeBtn.type = 'button';
        removeBtn.textContent = '×';
        removeBtn.title = 'הסר';
        (function (idx) {
          removeBtn.addEventListener('click', function () { removePhoto(idx); });
        })(index);
        li.appendChild(removeBtn);
      }

      dom.photoList.appendChild(li);
    });
  }

  function updateUploadBtn() {
    var hasPhotos = state.photos.length > 0;
    var allNamed = state.photos.every(function (p) { return p.name.trim() !== ''; });
    var anyConverting = state.photos.some(function (p) { return p.status === 'converting'; });
    dom.uploadBtn.disabled = !hasPhotos || !allNamed || state.uploading || anyConverting;
    dom.uploadBtn.textContent = hasPhotos
      ? 'העלאה (' + state.photos.length + ' תמונות)'
      : 'העלאה';
  }

  // ============================================
  // Upload
  // ============================================
  function startUpload() {
    if (state.photos.length === 0) return;

    state.uploading = true;
    dom.uploadBtn.disabled = true;
    dom.uploadProgress.hidden = false;
    dom.uploadResult.hidden = true;
    dom.progressFill.style.width = '0%';
    dom.progressText.textContent = 'מכין העלאה...';
    renderPhotos();

    var prepareTarget;
    if (state.uploadTargetId) {
      prepareTarget = Promise.resolve(state.uploadTargetId);
    } else if (state.targetFolder && state.targetFolder.create) {
      // Need to create תמונות folder first
      dom.progressText.textContent = 'יוצר תיקיית תמונות...';
      prepareTarget = createFolder(state.targetFolder.id, 'תמונות')
        .then(function (folder) {
          state.uploadTargetId = folder.id;
          state.targetFolderExists = true;
          return folder.id;
        });
    } else {
      state.uploading = false;
      return;
    }

    prepareTarget
      .then(function (targetId) {
        var total = state.photos.length;
        var done = 0;
        var failed = 0;

        // Mark all as uploading and fire all requests in parallel
        state.photos.forEach(function (photo) { photo.status = 'uploading'; });
        renderPhotos();
        dom.progressText.textContent = 'מעלה ' + total + ' תמונות...';
        dom.progressFill.style.width = '0%';

        var uploads = state.photos.map(function (photo) {
          var isHeic = /\.(heic|heif)$/i.test(photo.ext);
          var wasResized = photo.file.size > UPLOAD_MAX_BYTES;
          var ext = (wasResized || isHeic) ? '.jpg' : photo.ext;
          var fileName = photo.name.trim() + ext;
          return uploadFile(targetId, fileName, photo.file)
            .then(function () {
              photo.status = 'done';
              done++;
            })
            .catch(function (err) {
              photo.status = 'error';
              failed++;
              // Save the processed blob to offline queue for later retry
              if (err._offlineBlob) {
                addToOfflineQueue(targetId, fileName, err._offlineBlob).catch(function () {});
              }
            })
            .then(function () {
              dom.progressFill.style.width = ((done + failed) / total * 100) + '%';
              dom.progressText.textContent = (done + failed) + ' מתוך ' + total + ' הושלמו';
              renderPhotos();
            });
        });

        return Promise.all(uploads).then(function () {
          state.uploading = false;
          dom.uploadProgress.hidden = true;
          showUploadResult(done, failed, total);

          // Start retry cycle for any photos that were queued offline
          if (failed > 0) {
            scheduleRetry(RETRY_DELAY_MS);
          }

          // Remove all photos from the UI after upload:
          // - successful ones are on the server
          // - failed ones are now in the offline queue, managed by the retry engine
          //   (keeping them visible would let the user re-upload and create duplicate queue entries)
          state.photos = state.photos.filter(function (p) {
            return p.status !== 'done' && p.status !== 'error';
          });
          renderPhotos();
          updateUploadBtn();

          // Refresh file listing to show newly uploaded files
          var currentFolderId = state.uploadTargetId ||
            (state.breadcrumbs.length > 0 ? state.breadcrumbs[state.breadcrumbs.length - 1].id : null);
          if (currentFolderId) {
            fetchItems(currentFolderId)
              .then(function (items) {
                state.currentFiles = items.filter(function (item) { return !item.folder; });
                state.filesExpanded = true;
                renderFiles();
              })
              .catch(function () {});
          }
        });
      })
      .catch(function (err) {
        state.uploading = false;
        dom.uploadProgress.hidden = true;
        dom.uploadResult.hidden = false;
        dom.resultText.textContent = err.message || 'שגיאה ביצירת תיקיה';
        dom.resultText.className = 'upload-result__text upload-result__text--error';
        renderPhotos();
        updateUploadBtn();
      });
  }

  function showUploadResult(done, failed, total) {
    dom.uploadResult.hidden = false;
    if (failed === 0) {
      dom.resultText.textContent = 'הועלו בהצלחה ' + total + ' תמונות!';
      dom.resultText.className = 'upload-result__text upload-result__text--success';
    } else if (done === 0) {
      dom.resultText.textContent = 'ההעלאה נכשלה. נסה שוב.';
      dom.resultText.className = 'upload-result__text upload-result__text--error';
    } else {
      dom.resultText.textContent = done + ' מתוך ' + total + ' הועלו. ' + failed + ' נכשלו.';
      dom.resultText.className = 'upload-result__text upload-result__text--partial';
    }
  }

  // ============================================
  // Event Handlers
  // ============================================
  dom.searchInput.addEventListener('input', function () {
    state.searchQuery = dom.searchInput.value;
    renderFolders();
    renderFiles();
  });

  dom.filesToggle.addEventListener('click', function () {
    state.filesExpanded = !state.filesExpanded;
    renderFiles();
  });

  function handleSortClick(key) {
    if (state.filesSort.key === key) {
      state.filesSort.dir = state.filesSort.dir === 'desc' ? 'asc' : 'desc';
    } else {
      state.filesSort.key = key;
      state.filesSort.dir = key === 'date' ? 'desc' : 'asc';
    }
    sortFiles();
    renderFiles();
  }
  dom.filesSortDate.addEventListener('click', function () { handleSortClick('date'); });
  dom.filesSortName.addEventListener('click', function () { handleSortClick('name'); });

  function renderSortButtons() {
    var arrow = state.filesSort.dir === 'desc' ? ' ▼' : ' ▲';
    dom.filesSortDate.textContent = 'תאריך' + (state.filesSort.key === 'date' ? arrow : '');
    dom.filesSortName.textContent = 'שם' + (state.filesSort.key === 'name' ? arrow : '');
    dom.filesSortDate.classList.toggle('files-sort__btn--active', state.filesSort.key === 'date');
    dom.filesSortName.classList.toggle('files-sort__btn--active', state.filesSort.key === 'name');
  }

  dom.backBtn.addEventListener('click', function () {
    if (state.breadcrumbs.length > 1) {
      navigateToBreadcrumb(state.breadcrumbs.length - 2);
    }
  });

  dom.retryBtn.addEventListener('click', function () {
    var current = state.breadcrumbs[state.breadcrumbs.length - 1];
    if (current) {
      fetchAndDisplay(current.id);
    } else {
      loadRoot();
    }
  });

  dom.createReportsBtn.addEventListener('click', function () {
    var parentId = state.breadcrumbs[state.breadcrumbs.length - 1].id;

    dom.createReportsBtn.hidden = true;
    dom.reportsCreating.hidden = false;
    dom.reportsError.hidden = true;

    createFolder(parentId, 'דוחות ביקור')
      .then(function (folder) {
        // Navigate into the new folder
        selectFolder(folder.id, folder.name);
      })
      .catch(function (err) {
        dom.reportsError.textContent = err.message || 'שגיאה ביצירת תיקיה';
        dom.reportsError.hidden = false;
      })
      .then(function () {
        dom.createReportsBtn.hidden = false;
        dom.reportsCreating.hidden = true;
      });
  });

  dom.createVisitBtn.addEventListener('click', function () {
    var name = generateVisitName();
    dom.visitName.value = name;
    dom.visitForm.hidden = false;
    dom.visitError.hidden = true;

    // Detect previous visit for file copying
    var prev = findPreviousVisitFolder();
    state.previousVisit = null;
    dom.visitCopyPrompt.hidden = true;

    if (prev && prev.ambiguous) {
      // Show disambiguation prompt
      dom.copyChoiceNumber.textContent = prev.byNumber.name;
      dom.copyChoiceDate.textContent = prev.byDate.name;
      dom.visitCopyPrompt.hidden = false;
      state.previousVisit = null; // user must pick

      dom.copyChoiceNumber.onclick = function () {
        state.previousVisit = prev.byNumber;
        dom.visitCopyPrompt.hidden = true;
        dom.autoMsg.textContent = 'דוחות יועתקו מ: ' + prev.byNumber.name;
        dom.autoMsg.hidden = false;
      };
      dom.copyChoiceDate.onclick = function () {
        state.previousVisit = prev.byDate;
        dom.visitCopyPrompt.hidden = true;
        dom.autoMsg.textContent = 'דוחות יועתקו מ: ' + prev.byDate.name;
        dom.autoMsg.hidden = false;
      };
      dom.copySkip.onclick = function () {
        state.previousVisit = null;
        dom.visitCopyPrompt.hidden = true;
      };
    } else if (prev && !prev.ambiguous) {
      state.previousVisit = prev.folder;
    }
  });

  dom.confirmVisitBtn.addEventListener('click', function () {
    var visitName = dom.visitName.value.trim();
    if (!visitName) return;

    var parentId = state.breadcrumbs[state.breadcrumbs.length - 1].id;
    var prevVisit = state.previousVisit;

    dom.confirmVisitBtn.hidden = true;
    dom.visitCreating.hidden = false;
    dom.visitError.hidden = true;
    dom.visitName.disabled = true;
    dom.visitCopyPrompt.hidden = true;

    // Step 1: Create visit folder + תמונות
    createFolder(parentId, visitName)
      .then(function (visitFolder) {
        return createFolder(visitFolder.id, 'תמונות')
          .then(function (photosFolder) {
            return { visitFolder: visitFolder, photosFolder: photosFolder };
          });
      })
      .then(function (result) {
        // Success: update breadcrumbs and set target
        state.breadcrumbs.push({ name: result.visitFolder.name, id: result.visitFolder.id });
        state.breadcrumbs.push({ name: 'תמונות', id: result.photosFolder.id });
        state.targetFolder = result.photosFolder;
        state.targetFolderExists = true;
        state.uploadTargetId = result.photosFolder.id;

        // Update UI — user can start uploading photos immediately
        renderBreadcrumbs();
        dom.createVisit.hidden = true;
        dom.folderList.innerHTML = '';
        dom.empty.hidden = true;
        showTargetFolder();
        saveLocation();

        // Step 2: Copy files from previous visit (background, non-blocking)
        if (prevVisit) {
          copyPreviousVisitFiles(prevVisit.id, result.visitFolder.id, visitName)
            .then(function (copyResult) {
              if (copyResult.copied.length > 0) {
                renameReportFiles(copyResult.copied, visitName, result.visitFolder.id)
                  .then(function () { showCopyResult(copyResult); });
              }
            })
            .catch(function () {
              // Copy failure is non-critical — don't show error
            });
        }
      })
      .catch(function (err) {
        dom.visitError.textContent = err.message || 'שגיאה ביצירת תיקיה';
        dom.visitError.hidden = false;
      })
      .then(function () {
        // Always reset form state
        dom.confirmVisitBtn.hidden = false;
        dom.visitCreating.hidden = true;
        dom.visitName.disabled = false;
      });
  });

  dom.uploadBtn.addEventListener('click', function () {
    startUpload();
  });

  dom.photoInput.addEventListener('change', function () {
    if (dom.photoInput.files.length > 0) {
      addPhotos(dom.photoInput.files);
    }
    dom.photoInput.value = '';
  });

  dom.cameraInput.addEventListener('change', function () {
    if (dom.cameraInput.files.length > 0) {
      addPhotos(dom.cameraInput.files);
    }
    dom.cameraInput.value = '';
  });

  dom.resultCloseBtn.addEventListener('click', function () {
    dom.uploadResult.hidden = true;
  });

  dom.savedLocationBtn.addEventListener('click', function () {
    var saved = loadSavedLocation();
    if (saved) {
      restoreSavedLocation(saved);
    } else {
      dom.savedLocation.hidden = true;
      fetchAndDisplay('root');
    }
  });

  dom.savedLocationChange.addEventListener('click', function () {
    dom.savedLocation.hidden = true;
    fetchAndDisplay('root');
  });

  // Offline download button
  var offlineDownloadBtn = document.getElementById('offline-download-btn');
  if (offlineDownloadBtn) {
    offlineDownloadBtn.addEventListener('click', function () {
      downloadQueuedPhotos();
    });
  }

  // Offline banner — סגור button with confirmation dialog

  // Remove every record from the offline queue (called after user confirms).
  function clearOfflineQueue() {
    return offlineTx('readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        var req = store.clear();
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  var offlineConfirmOverlay = document.getElementById('offline-confirm-overlay');

  function showOfflineConfirm() {
    if (offlineConfirmOverlay) offlineConfirmOverlay.hidden = false;
  }

  function hideOfflineConfirm() {
    if (offlineConfirmOverlay) offlineConfirmOverlay.hidden = true;
  }

  // "סגור" button — opens the confirmation dialog
  var offlineCloseBtn = document.getElementById('offline-close-btn');
  if (offlineCloseBtn) {
    offlineCloseBtn.addEventListener('click', function () {
      showOfflineConfirm();
    });
  }

  // "המשך" — clear the queue and hide the banner
  var offlineConfirmProceed = document.getElementById('offline-confirm-proceed');
  if (offlineConfirmProceed) {
    offlineConfirmProceed.addEventListener('click', function () {
      // Cancel any pending retry timer so it doesn't fire after the queue is cleared
      if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
      clearOfflineQueue()
        .catch(function () {})
        .then(function () {
          hideOfflineConfirm();
          var banner = document.getElementById('offline-banner');
          if (banner) banner.hidden = true;
        });
    });
  }

  // "בטל" — close the dialog, leave everything as-is
  var offlineConfirmCancel = document.getElementById('offline-confirm-cancel');
  if (offlineConfirmCancel) {
    offlineConfirmCancel.addEventListener('click', function () {
      hideOfflineConfirm();
    });
  }

  // Close on backdrop tap (outside the dialog box)
  if (offlineConfirmOverlay) {
    offlineConfirmOverlay.addEventListener('click', function (e) {
      if (e.target === offlineConfirmOverlay) hideOfflineConfirm();
    });
  }

  // ============================================
  // Init
  // ============================================
  checkDeferredUploads(); // check for pending offline photos on every app load
  loadRoot();
})();
