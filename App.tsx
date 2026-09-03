import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { usePreventScreenCapture } from "expo-screen-capture";
import * as FileSystem from "expo-file-system/legacy";
import NetInfo from "@react-native-community/netinfo";

const PDF_URL = "https://drive.google.com/uc?export=download&confirm=t&id=1ttnTzgZEobC2_zmWLvhL7AKiNbgRh-P5";

function createViewerHtml(pdfUri: string) {
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/web/pdf_viewer.css">
<style>
html, body {
  margin: 0;
  background: #e8e8e8;
  -webkit-text-size-adjust: 100% !important;
  text-size-adjust: 100% !important;
}
#viewerContainer { position: absolute; inset: 0; overflow: auto; }
#viewer { padding: 8px 0 24px; }
.pdfViewer .page { margin: 10px auto; background: #fff; box-shadow: 0 1px 4px #555; position: relative; }

.custom-highlight {
  position: absolute;
  background-color: rgba(255, 235, 59, 0.4);
  pointer-events: none;
  border-radius: 2px;
  z-index: 10;
}
.custom-highlight.active {
  background-color: rgba(255, 152, 0, 0.5);
  border: 2px solid rgba(220, 100, 0, 0.8);
  z-index: 11;
}
.error, .loading { padding: 32px; text-align: center; }
.error { color: #b00020; }
</style>
</head>
<body>
<div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div>
<script type="module">
import { getDocument, GlobalWorkerOptions } from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import { EventBus, PDFLinkService, PDFViewer } from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/web/pdf_viewer.mjs";

GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
const container = document.getElementById("viewerContainer");
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });

const pdfViewer = new PDFViewer({
  container,
  eventBus,
  linkService,
  textLayerMode: 0, 
  removePageBorders: true
});
linkService.setViewer(pdfViewer);

let customSearchIndex = [];
let currentMatches = [];
let activeMatchIndex = -1;
let pdfDoc = null;

function send(type, data) {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type, ...(data || {}) }));
  }
}

// 1. Build Index using pure Content Stream Order + Linear Width Distribution
async function buildSearchIndex(pdf) {
  customSearchIndex = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    // Allow natural combination, do not force granular chunks
    const textContent = await page.getTextContent(); 
    
    let pageString = "";
    let mapping = [];

    textContent.items.forEach(item => {
      const text = item.str || "";
      const cleanedText = text.replace(/[\\s\\u200B-\\u200D]/g, "");
      
      if (cleanedText.length > 0) {
        // Linearly distribute the bounding box width across the actual characters
        const avgWidth = (item.width || 0) / Math.max(1, text.length);
        let currentX = item.transform[4];
        const currentY = item.transform[5];
        const height = Math.abs(item.transform[3] || item.height || 12);
        
        for (let c = 0; c < text.length; c++) {
          const char = text[c];
          // Only map visible characters to our searchable string
          if (char.trim().length > 0 && char !== '\\u200B' && char !== '\\u200D') {
            pageString += char;
            mapping.push({ x: currentX, y: currentY, width: avgWidth, height: height });
          }
          // Advance X for every character (even spaces) to maintain geometric integrity
          currentX += avgWidth; 
        }
      }
    });
    
    customSearchIndex.push({ pageNum: i, searchableText: pageString, mapping });
  }
}

// 2. Strict Mathematical Envelope Merge
function mergeBoxes(boxes) {
    if (boxes.length === 0) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxHeight = 0;

    boxes.forEach(b => {
        if (b.x < minX) minX = b.x;
        if (b.x + b.width > maxX) maxX = b.x + b.width;
        if (b.y < minY) minY = b.y; 
        if (b.height > maxHeight) maxHeight = b.height;
    });

    return { 
        x: minX, 
        y: minY, 
        width: Math.max(0, maxX - minX), 
        height: maxHeight 
    };
}

eventBus.on("pagerendered", (e) => {
  drawHighlightsForPage(e.pageNumber);
});

eventBus.on("pagesinit", () => {
  pdfViewer.currentScaleValue = "page-width";
});

window.addEventListener("resize", () => {
  pdfViewer.currentScaleValue = "page-width";
});

async function render() {
  try {
    pdfDoc = await getDocument({ 
      url: ${JSON.stringify(pdfUri)},
      cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/",
      cMapPacked: true
    }).promise;
    
    pdfViewer.setDocument(pdfDoc);
    await buildSearchIndex(pdfDoc);
    
    send("pdf-ready", { pages: pdfDoc.numPages });
  } catch (error) {
    send("pdf-error", { message: String(error) });
  }
}

window.search = (query) => {
  currentMatches = [];
  activeMatchIndex = -1;
  document.querySelectorAll('.custom-highlight').forEach(e => e.remove());

  if (!query) {
     send("search", { current: 0, total: 0 });
     return;
  }

  // FIX: Convert the normalized query to lowercase
  const normalizedQuery = String(query).replace(/[\\s\\u200B-\\u200D]/g, "").toLowerCase();
  if (!normalizedQuery) return;

  customSearchIndex.forEach((pageData) => {
    let startIndex = 0;
    let matchIdx;
    
    // FIX: Convert the page text to lowercase before searching
    const pageTextLower = pageData.searchableText.toLowerCase();
    
    while ((matchIdx = pageTextLower.indexOf(normalizedQuery, startIndex)) > -1) {
      
      let matchBoxes = [];
      for (let i = 0; i < normalizedQuery.length; i++) {
        matchBoxes.push(pageData.mapping[matchIdx + i]);
      }

      let matchRects = [];
      let currentLineBoxes = [];
      let currentY = null;

      matchBoxes.forEach(box => {
        if (currentY === null) {
          currentY = box.y;
          currentLineBoxes.push(box);
        } else {
          if (Math.abs(currentY - box.y) < 10) {
            currentLineBoxes.push(box);
          } else {
            matchRects.push(mergeBoxes(currentLineBoxes));
            currentLineBoxes = [box];
            currentY = box.y;
          }
        }
      });
      
      if (currentLineBoxes.length > 0) {
        matchRects.push(mergeBoxes(currentLineBoxes));
      }

      currentMatches.push({ pageNum: pageData.pageNum, rects: matchRects });
      startIndex = matchIdx + 1;
    }
  });

  if (currentMatches.length > 0) {
    activeMatchIndex = 0;
    highlightCurrentMatch();
  } else {
    send("search", { current: 0, total: 0 });
  }
};

window.nextMatch = () => {
  if (currentMatches.length === 0) return;
  activeMatchIndex = (activeMatchIndex + 1) % currentMatches.length;
  highlightCurrentMatch();
};

window.prevMatch = () => {
  if (currentMatches.length === 0) return;
  activeMatchIndex = (activeMatchIndex - 1 + currentMatches.length) % currentMatches.length;
  highlightCurrentMatch();
};

function highlightCurrentMatch() {
  send("search", { current: activeMatchIndex + 1, total: currentMatches.length });
  
  const match = currentMatches[activeMatchIndex];
  if (!match) return;

  if (pdfViewer.currentPageNumber !== match.pageNum) {
    pdfViewer.currentPageNumber = match.pageNum;
  }
  drawHighlightsForPage(match.pageNum);
}

function drawHighlightsForPage(pageNum) {
  const pageView = pdfViewer.getPageView(pageNum - 1);
  if (!pageView || !pageView.div) return;
  
  pageView.div.querySelectorAll('.custom-highlight').forEach(e => e.remove());

  const pageMatches = currentMatches
    .map((m, index) => ({...m, index}))
    .filter(m => m.pageNum === pageNum);
    
  if (pageMatches.length === 0) return;

  const viewport = pageView.viewport;

  pageMatches.forEach(match => {
    match.rects.forEach(rect => {
      if (!rect) return;
      const pt = viewport.convertToViewportPoint(rect.x, rect.y);
      const scaledWidth = rect.width * viewport.scale;
      const scaledHeight = rect.height * viewport.scale;

      const div = document.createElement('div');
      div.className = 'custom-highlight' + (match.index === activeMatchIndex ? ' active' : '');
      
      div.style.left = pt[0] + 'px';
      div.style.top = (pt[1] - scaledHeight) + 'px'; 
      div.style.width = scaledWidth + 'px';
      div.style.height = (scaledHeight * 1.2) + 'px'; 
      
      pageView.div.appendChild(div);
      
      if (match.index === activeMatchIndex) {
         div.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });
}

render();
</script>
</body>
</html>`;
}

export default function App() {
  usePreventScreenCapture();
  const [viewerUri, setViewerUri] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [count, setCount] = useState("0/0");
  const [showSearch, setShowSearch] = useState(false);
  const webRef = useRef<WebView>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const pdfUri = `${FileSystem.cacheDirectory}grammar-document.pdf`;
        
        // Check if file already exists in cache
        const fileInfo = await FileSystem.getInfoAsync(pdfUri);
        if (!fileInfo.exists) {
          console.log("[GrammarApp] Downloading PDF...");
          await FileSystem.downloadAsync(PDF_URL, pdfUri);
          console.log("[GrammarApp] PDF downloaded and cached:", pdfUri);
        } else {
          console.log("[GrammarApp] Using cached PDF:", pdfUri);
        }
        
        const viewerUri = `${FileSystem.cacheDirectory}pdf-viewer.html`;
        await FileSystem.writeAsStringAsync(viewerUri, createViewerHtml(pdfUri), { encoding: FileSystem.EncodingType.UTF8 });
        setViewerUri(viewerUri);
        
        // Background check for updates if internet is available
        (async () => {
          try {
            const state = await NetInfo.fetch();
            if (state.isConnected) {
              console.log("[GrammarApp] Checking for updates...");
              const tempUri = `${FileSystem.cacheDirectory}grammar-document-temp.pdf`;
              
              await FileSystem.downloadAsync(PDF_URL, tempUri);
              const tempInfo = await FileSystem.getInfoAsync(tempUri);
              const cachedInfo = await FileSystem.getInfoAsync(pdfUri);
              
              // Compare file sizes to detect changes
              if (tempInfo.exists && cachedInfo.exists && "size" in tempInfo && "size" in cachedInfo) {
                const tempSize = (tempInfo as any).size;
                const cachedSize = (cachedInfo as any).size;
                
                if (tempSize !== cachedSize) {
                  console.log("[GrammarApp] PDF update detected. Replacing cached file...");
                  await FileSystem.moveAsync({ from: tempUri, to: pdfUri });
                  // Reload viewer HTML to use updated PDF
                  await FileSystem.writeAsStringAsync(viewerUri, createViewerHtml(pdfUri), { encoding: FileSystem.EncodingType.UTF8 });
                } else {
                  console.log("[GrammarApp] PDF is up to date");
                  // Clean up temp file
                  await FileSystem.deleteAsync(tempUri).catch(() => {});
                }
              } else {
                console.log("[GrammarApp] Could not compare file sizes");
                // Clean up temp file
                await FileSystem.deleteAsync(tempUri).catch(() => {});
              }
            }
          } catch (error) {
            console.log("[GrammarApp] Background update check failed:", error);
          }
        })();
        
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error("[GrammarApp] PDF load failed:", message);
        setError(message);
      }
    })();
  }, []);

  function search(value: string) {
    setQuery(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      webRef.current?.injectJavaScript(`window.search(${JSON.stringify(value)});true;`);
    }, 250);
  }

  function move(name: "nextMatch" | "prevMatch") {
    webRef.current?.injectJavaScript(`window.${name}();true;`);
  }

  if (error) return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
      <Text style={{ color: "#b00020", fontSize: 18 }}>Unable to load PDF</Text>
      <Text>{error}</Text>
    </View>
  );

  if (!viewerUri) return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
      <ActivityIndicator size="large" />
      <Text style={{ marginTop: 12 }}>Downloading document...</Text>
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={{ backgroundColor: "#1565C0", padding: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: "white", fontSize: 20, fontWeight: "bold" }}>Contact: 8247829025</Text>
        <TouchableOpacity onPress={() => {
          if (showSearch) {
            setQuery("");
            webRef.current?.injectJavaScript(`window.search("");true;`);
          }
          setShowSearch(!showSearch);
        }}>
          <MaterialIcons name={showSearch ? "close" : "search"} color="white" size={28} />
        </TouchableOpacity>
      </View>
      
      {showSearch && (
        <View style={{ backgroundColor: "#1565C0", padding: 12 }}>
          <View style={{ backgroundColor: "white", height: 48, flexDirection: "row", alignItems: "center", paddingHorizontal: 10 }}>
            <TextInput autoFocus style={{ flex: 1, fontSize: 17 }} placeholder="Search..." value={query} onChangeText={search} />
            <Text style={{ marginHorizontal: 10 }}>{count}</Text>
            <TouchableOpacity onPress={() => move("prevMatch")}>
              <MaterialIcons name="keyboard-arrow-up" size={28} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => move("nextMatch")}>
              <MaterialIcons name="keyboard-arrow-down" size={28} />
            </TouchableOpacity>
          </View>
        </View>
      )}
      
      <WebView 
        ref={webRef} 
        source={{ uri: viewerUri }} 
        originWhitelist={["*"]} 
        javaScriptEnabled 
        domStorageEnabled 
        allowFileAccess 
        allowFileAccessFromFileURLs 
        allowUniversalAccessFromFileURLs 
        style={{ flex: 1 }} 
        onMessage={(event) => { 
          try { 
            const data = JSON.parse(event.nativeEvent.data); 
            console.log("[GrammarApp] PDF message:", data); 
            if (data.type === "search") setCount(`${data.current}/${data.total}`); 
            if (data.type === "pdf-error") setError(data.message); 
          } catch (cause) { 
            console.error("[GrammarApp] PDF message error:", cause); 
          } 
        }} 
        onError={(event) => console.error("[GrammarApp] WebView error:", event.nativeEvent)} 
      />
    </SafeAreaView>
  );
}