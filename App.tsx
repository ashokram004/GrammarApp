import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { usePreventScreenCapture } from "expo-screen-capture";
import * as FileSystem from "expo-file-system/legacy";

const PDF_URL = "https://drive.google.com/uc?export=download&id=1ttnTzgZEobC2_zmWLvhL7AKiNbgRh-P5";

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

// Hidden canvas to measure proportional character widths accurately
const measureCanvas = document.createElement('canvas');
const measureCtx = measureCanvas.getContext('2d');
measureCtx.font = '16px sans-serif'; 

function send(type, data) {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type, ...(data || {}) }));
  }
}

async function buildSearchIndex(pdf) {
  customSearchIndex = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    
    let pageString = "";
    let mapping = [];

    // 1. Sort text chunks visually (Top to Bottom, then Left to Right)
    const sortedItems = textContent.items.slice().sort((a, b) => {
      const yDiff = b.transform[5] - a.transform[5];
      // If Y difference is greater than 5 points, they are on different lines
      if (Math.abs(yDiff) > 5) return b.transform[5] - a.transform[5];
      // Otherwise, sort by X coordinate (Left to Right)
      return a.transform[4] - b.transform[4];
    });

    sortedItems.forEach(item => {
      const text = item.str;
      const height = item.height || Math.abs(item.transform[3]);
      
      // Calculate relative width ratios using canvas
      const totalEstWidth = measureCtx.measureText(text).width;
      const widthScale = totalEstWidth === 0 ? 0 : item.width / totalEstWidth;

      let currentX = item.transform[4];
      const currentY = item.transform[5];

      for (let c = 0; c < text.length; c++) {
        const char = text[c];
        const charWidth = measureCtx.measureText(char).width * widthScale;

        if (char.trim().length > 0 && char !== '\\u200B' && char !== '\\u200D') {
          pageString += char;
          mapping.push({
            x: currentX,
            y: currentY,
            width: charWidth,
            height: height
          });
        }
        currentX += charWidth;
      }
    });
    customSearchIndex.push({ pageNum: i, searchableText: pageString, mapping });
  }
}

eventBus.on("pagerendered", (e) => {
  drawHighlightsForPage(e.pageNumber);
});

eventBus.on("pagesinit", () => {
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

  const normalizedQuery = String(query).replace(/[\\s\\u200B-\\u200D]/g, "");
  if (!normalizedQuery) return;

  customSearchIndex.forEach((pageData) => {
    let startIndex = 0;
    let matchIdx;
    
    while ((matchIdx = pageData.searchableText.indexOf(normalizedQuery, startIndex)) > -1) {
      let matchRects = [];
      let currentRect = null;

      // Group highlights by line to prevent giant screen-covering boxes
      for (let i = 0; i < normalizedQuery.length; i++) {
        const charBox = pageData.mapping[matchIdx + i];
        if (!currentRect) {
          currentRect = { x: charBox.x, y: charBox.y, width: charBox.width, height: charBox.height };
        } else {
          // If the character is on the same line (Y diff < 5)
          if (Math.abs(currentRect.y - charBox.y) < 5) {
            const newMaxX = Math.max(currentRect.x + currentRect.width, charBox.x + charBox.width);
            currentRect.x = Math.min(currentRect.x, charBox.x);
            currentRect.width = newMaxX - currentRect.x;
            currentRect.height = Math.max(currentRect.height, charBox.height);
          } else {
            // New line, save the old rect and start a new one
            matchRects.push(currentRect);
            currentRect = { x: charBox.x, y: charBox.y, width: charBox.width, height: charBox.height };
          }
        }
      }
      if (currentRect) matchRects.push(currentRect);

      currentMatches.push({
        pageNum: pageData.pageNum,
        rects: matchRects
      });
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
    // Loop through all rectangles making up this match
    match.rects.forEach(rect => {
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
  // usePreventScreenCapture();
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
        console.log("[GrammarApp] Downloading PDF...");
        const pdfUri = `${FileSystem.cacheDirectory}grammar-document.pdf`;
        await FileSystem.downloadAsync(PDF_URL, pdfUri);
        const viewerUri = `${FileSystem.cacheDirectory}pdf-viewer.html`;
        await FileSystem.writeAsStringAsync(viewerUri, createViewerHtml(pdfUri), { encoding: FileSystem.EncodingType.UTF8 });
        console.log("[GrammarApp] PDF cached:", pdfUri);
        setViewerUri(viewerUri);
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
        <TouchableOpacity onPress={() => setShowSearch(!showSearch)}>
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