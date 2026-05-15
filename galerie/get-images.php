<?php
/**
 * ═══════════════════════════════════════════════════════
 * DROPBOX GALLERY API ENDPOINT
 * ═══════════════════════════════════════════════════════
 * 
 * Diese Datei fungiert als Backend-Schnittstelle zwischen
 * der Frontend-Galerie und der Dropbox API.
 * 
 * SETUP:
 * 1. Ersetze DEIN_DROPBOX_TOKEN mit deinem persönlichen Dropbox Access Token
 * 2. Passe DROPBOX_FOLDER_PATH an deinen gewünschten Ordner an
 * 
 */

// ═══════════════════════════════════════════════════════
// KONFIGURATION
// ═══════════════════════════════════════════════════════

define('DROPBOX_ACCESS_TOKEN', 'DEIN_DROPBOX_TOKEN');  // 🔑 Ersetze mit deinem Token!
define('DROPBOX_FOLDER_PATH', '/meine-fotos');          // 📁 Dein Dropbox-Ordnerpfad
define('CACHE_DURATION', 3600);                         // Cache-Dauer in Sekunden (1 Stunde)

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: public, max-age=3600');

// ═══════════════════════════════════════════════════════
// VALIDIERUNG & ERROR HANDLING
// ═══════════════════════════════════════════════════════

if (DROPBOX_ACCESS_TOKEN === 'DEIN_DROPBOX_TOKEN') {
    http_response_code(401);
    echo json_encode([
        'error' => 'Authentifizierungsfehler',
        'message' => 'Dropbox Access Token nicht konfiguriert. Bitte get-images.php bearbeiten.'
    ]);
    exit;
}

// ═══════════════════════════════════════════════════════
// CACHE HANDLING
// ═══════════════════════════════════════════════════════

function getCacheFile() {
    return sys_get_temp_dir() . '/dropbox_gallery_cache_' . md5(DROPBOX_FOLDER_PATH) . '.json';
}

function getCachedData() {
    $cacheFile = getCacheFile();
    
    if (file_exists($cacheFile)) {
        $age = time() - filemtime($cacheFile);
        if ($age < CACHE_DURATION) {
            $data = file_get_contents($cacheFile);
            return json_decode($data, true);
        }
    }
    
    return null;
}

function setCacheData($data) {
    $cacheFile = getCacheFile();
    file_put_contents($cacheFile, json_encode($data));
}

// ═══════════════════════════════════════════════════════
// MAIN LOGIC
// ═══════════════════════════════════════════════════════

try {
    // Versuche aus Cache zu laden
    $cachedData = getCachedData();
    if ($cachedData !== null) {
        echo json_encode($cachedData);
        exit;
    }
    
    // Dropbox API Request
    $ch = curl_init();
    
    curl_setopt_array($ch, [
        CURLOPT_URL => 'https://api.dropboxapi.com/2/files/list_folder',
        CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . DROPBOX_ACCESS_TOKEN,
            'Content-Type: application/json'
        ],
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode([
            'path' => DROPBOX_FOLDER_PATH,
            'recursive' => false,
            'include_media_info' => true
        ]),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => true
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);
    
    // ═══════════════════════════════════════════════════════
    // ERROR HANDLING
    // ═══════════════════════════════════════════════════════
    
    if ($curlError) {
        http_response_code(500);
        echo json_encode([
            'error' => 'Verbindungsfehler',
            'message' => 'Konnte Dropbox nicht erreichen: ' . $curlError
        ]);
        exit;
    }
    
    $data = json_decode($response, true);
    
    if ($httpCode !== 200) {
        http_response_code($httpCode);
        echo json_encode([
            'error' => $data['error_summary'] ?? 'API-Fehler',
            'message' => $data['error'] ?? 'Unbekannter Fehler von Dropbox',
            'http_code' => $httpCode
        ]);
        exit;
    }
    
    // ═══════════════════════════════════════════════════════
    // PROCESS ENTRIES
    // ═══════════════════════════════════════════════════════
    
    $entries = $data['entries'] ?? [];
    $processedEntries = [];
    
    foreach ($entries as $entry) {
        // Nur Dateien, keine Ordner
        if ($entry['.tag'] !== 'file') {
            continue;
        }
        
        // Versteckte Dateien ignorieren
        if (strpos($entry['name'], '.') === 0) {
            continue;
        }
        
        // Bildextensionen filtern
        $allowedExtensions = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tiff', 'bmp'];
        $fileExt = strtolower(pathinfo($entry['name'], PATHINFO_EXTENSION));
        
        if (!in_array($fileExt, $allowedExtensions)) {
            continue;
        }
        
        // Temporären Download-Link abrufen
        $tempLink = getTemporaryLink($entry['id']);
        
        if ($tempLink) {
            $processedEntries[] = [
                'name' => $entry['name'],
                'path' => $entry['path_display'],
                'id' => $entry['id'],
                'size' => $entry['size'] ?? 0,
                'modified' => $entry['server_modified'] ?? null,
                'url' => $tempLink
            ];
        }
    }
    
    // ═══════════════════════════════════════════════════════
    // RESPONSE
    // ═══════════════════════════════════════════════════════
    
    $response = [
        'success' => true,
        'count' => count($processedEntries),
        'entries' => $processedEntries,
        'folder' => DROPBOX_FOLDER_PATH,
        'cached' => false,
        'timestamp' => time()
    ];
    
    // Cache speichern
    setCacheData($response);
    
    echo json_encode($response);
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'error' => 'Servergebäude',
        'message' => $e->getMessage()
    ]);
}

// ═══════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════

/**
 * Ruft einen temporären Download-Link für eine Datei ab
 * Diese Links sind 4 Stunden gültig
 */
function getTemporaryLink($fileId) {
    $ch = curl_init();
    
    curl_setopt_array($ch, [
        CURLOPT_URL => 'https://api.dropboxapi.com/2/files/get_temporary_link',
        CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . DROPBOX_ACCESS_TOKEN,
            'Content-Type: application/json'
        ],
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode([
            'path' => $fileId
        ]),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 5,
        CURLOPT_SSL_VERIFYPEER => true
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    
    if ($httpCode === 200) {
        $data = json_decode($response, true);
        return $data['link'] ?? null;
    }
    
    return null;
}

?>