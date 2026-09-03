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

/* Virtual TOC Links Styling */
.toc-link {
  position: absolute;
  cursor: pointer;
  z-index: 5;
  border-radius: 4px;
}
.toc-link:hover {
}

/* Custom Scrollbar Thumb */
#scrollbarThumb {
  position: fixed;
  right: 2px;
  width: 16px;
  background-color: rgba(0, 0, 0, 0.4);
  border-radius: 4px;
  z-index: 100;
  cursor: pointer;
  top: 0;
  touch-action: none;
}
#scrollbarThumb:hover, #scrollbarThumb.dragging {
  background-color: rgba(0, 0, 0, 0.6);
}

/* Page Number Badge Styling */
.custom-page-number {
  position: absolute;
  bottom: 12px;
  right: 12px;
  background-color: rgba(0, 0, 0, 0.5);
  color: white;
  font-family: sans-serif;
  font-size: 13px;
  font-weight: bold;
  padding: 4px 10px;
  border-radius: 12px;
  pointer-events: none;
  z-index: 20;
}

.error, .loading { padding: 32px; text-align: center; }
.error { color: #b00020; }
</style>
</head>
<body>
<div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div>
<div id="scrollbarThumb"></div>
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
let tocLinks = [];

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

    textContent.items.forEach(item => {
      const text = item.str || "";
      const cleanedText = text.replace(/[\\s\\u200B-\\u200D]/g, "");
      
      if (cleanedText.length > 0) {
        const avgWidth = (item.width || 0) / Math.max(1, text.length);
        let currentX = item.transform[4];
        const currentY = item.transform[5];
        const height = Math.abs(item.transform[3] || item.height || 12);
        
        for (let c = 0; c < text.length; c++) {
          const char = text[c];
          if (char.trim().length > 0 && char !== '\\u200B' && char !== '\\u200D') {
            pageString += char;
            mapping.push({ x: currentX, y: currentY, width: avgWidth, height: height });
          }
          currentX += avgWidth; 
        }
      }
    });
    
    customSearchIndex.push({ pageNum: i, searchableText: pageString, mapping });
  }
}

// Bulletproof TOC Builder
async function buildTOCLinks(pdf) {
  tocLinks = [];
  for (let i = 2; i <= 4; i++) {
    if (i > pdf.numPages) break;
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent({ disableCombineTextItems: true });
    
    let lines = {};
    textContent.items.forEach(item => {
       if (!item.str.trim()) return;
       const y = Math.round(item.transform[5] / 5) * 5; 
       if (!lines[y]) lines[y] = [];
       lines[y].push(item);
    });

    Object.values(lines).forEach(lineItems => {
       lineItems.sort((a,b) => a.transform[4] - b.transform[4]); 
       
       const fullLineString = lineItems.map(item => item.str).join("").replace(/[\\s\\u200B-\\u200D]/g, "");
       const match = fullLineString.match(/(\\d+)[^\\d]*$/);
       
       if (match) {
          const targetPage = parseInt(match[1], 10);
          
          if (targetPage > 0 && targetPage <= pdf.numPages) {
              let minX = Infinity, maxX = -Infinity, minY = Infinity, maxHeight = 0;
              lineItems.forEach(b => {
                  const x = b.transform[4];
                  const y = b.transform[5];
                  const w = b.width || 0;
                  const h = Math.abs(b.transform[3] || b.height || 12);
                  if (x < minX) minX = x;
                  if (x + w > maxX) maxX = x + w;
                  if (y < minY) minY = y;
                  if (h > maxHeight) maxHeight = h;
              });
              
              tocLinks.push({
                 sourcePage: i,
                 targetPage: targetPage,
                 rect: { x: minX, y: minY, width: maxX - minX, height: maxHeight }
              });
          }
       }
    });
  }
}

async function render() {
  try {
    pdfDoc = await getDocument({ 
      url: ${JSON.stringify(pdfUri)},
      cMapUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/",
      cMapPacked: true
    }).promise;
    
    pdfViewer.setDocument(pdfDoc);
    linkService.setDocument(pdfDoc); 
    
    await buildTOCLinks(pdfDoc);
    
    for (let i = 2; i <= 4; i++) {
       drawTOCLinksForPage(i);
    }
    
    await buildSearchIndex(pdfDoc);
    
    send("pdf-ready", { pages: pdfDoc.numPages });
  } catch (error) {
    send("pdf-error", { message: String(error) });
  }
}

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
  drawTOCLinksForPage(e.pageNumber); 
  stampPageNumber(e.pageNumber);
  send("page-changed", { page: e.pageNumber });
});

function stampPageNumber(pageNum) {
  const pageView = pdfViewer.getPageView(pageNum - 1);
  if (!pageView || !pageView.div) return;
  
  pageView.div.querySelectorAll('.custom-page-number').forEach(e => e.remove());

  const badge = document.createElement('div');
  badge.className = 'custom-page-number';
  badge.innerText = pageNum;
  
  pageView.div.appendChild(badge);
}

eventBus.on("pagesinit", () => {
  pdfViewer.currentScaleValue = "page-width";
});

window.addEventListener("resize", () => {
  pdfViewer.currentScaleValue = "page-width";
});

// External trigger from React Native slider
const scrollbarThumb = document.getElementById('scrollbarThumb');
let isDraggingScrollbar = false;
let scrollbarStartY = 0;
let containerStartScrollY = 0;

function updateScrollbarThumb() {
  const container = document.getElementById('viewerContainer');
  if (!container || !pdfDoc) return;
  
  const scrollHeight = container.scrollHeight;
  const clientHeight = container.clientHeight;
  const scrollTop = container.scrollTop;
  
  if (scrollHeight <= clientHeight) {
    scrollbarThumb.style.display = 'none';
    return;
  }
  
  scrollbarThumb.style.display = 'block';
  const thumbHeight = Math.max(30, (clientHeight / scrollHeight) * clientHeight);
  const thumbTop = (scrollTop / scrollHeight) * clientHeight;
  
  scrollbarThumb.style.height = thumbHeight + 'px';
  scrollbarThumb.style.top = thumbTop + 'px';
}

scrollbarThumb.addEventListener('mousedown', (e) => {
  isDraggingScrollbar = true;
  scrollbarStartY = e.clientY;
  containerStartScrollY = document.getElementById('viewerContainer').scrollTop;
  scrollbarThumb.classList.add('dragging');
  e.preventDefault();
});

scrollbarThumb.addEventListener('touchstart', (e) => {
  isDraggingScrollbar = true;
  scrollbarStartY = e.touches[0].clientY;
  containerStartScrollY = document.getElementById('viewerContainer').scrollTop;
  scrollbarThumb.classList.add('dragging');
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isDraggingScrollbar) return;
  
  const container = document.getElementById('viewerContainer');
  const deltaY = e.clientY - scrollbarStartY;
  const maxScroll = container.scrollHeight - container.clientHeight;
  const scrollRatio = maxScroll / container.clientHeight;
  const newScrollTop = Math.min(maxScroll, Math.max(0, containerStartScrollY + (deltaY * scrollRatio)));
  
  container.scrollTop = newScrollTop;
  updateScrollbarThumb();
});

document.addEventListener('touchmove', (e) => {
  if (!isDraggingScrollbar) return;
  
  const container = document.getElementById('viewerContainer');
  const deltaY = e.touches[0].clientY - scrollbarStartY;
  const maxScroll = container.scrollHeight - container.clientHeight;
  const scrollRatio = maxScroll / container.clientHeight;
  const newScrollTop = Math.min(maxScroll, Math.max(0, containerStartScrollY + (deltaY * scrollRatio)));
  
  container.scrollTop = newScrollTop;
  updateScrollbarThumb();
  e.preventDefault();
});

document.addEventListener('mouseup', () => {
  if (isDraggingScrollbar) {
    isDraggingScrollbar = false;
    scrollbarThumb.classList.remove('dragging');
  }
});

document.addEventListener('touchend', () => {
  if (isDraggingScrollbar) {
    isDraggingScrollbar = false;
    scrollbarThumb.classList.remove('dragging');
  }
});

document.getElementById('viewerContainer').addEventListener('scroll', updateScrollbarThumb);
window.addEventListener('resize', updateScrollbarThumb);

window.goToPage = (pageNum) => {
  if (pdfViewer && pageNum > 0 && pageNum <= pdfDoc.numPages) {
    pdfViewer.currentPageNumber = pageNum;
  }
};

window.search = (query) => {
  currentMatches = [];
  activeMatchIndex = -1;
  document.querySelectorAll('.custom-highlight').forEach(e => e.remove());

  if (!query) {
     send("search", { current: 0, total: 0 });
     return;
  }

  const normalizedQuery = String(query).replace(/[\\s\\u200B-\\u200D]/g, "").toLowerCase();
  if (!normalizedQuery) return;

  customSearchIndex.forEach((pageData) => {
    let startIndex = 0;
    let matchIdx;
    
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

function drawTOCLinksForPage(pageNum) {
  const pageView = pdfViewer.getPageView(pageNum - 1);
  if (!pageView || !pageView.div) return;
  
  pageView.div.querySelectorAll('.toc-link').forEach(e => e.remove());

  const links = tocLinks.filter(l => l.sourcePage === pageNum);
  if (links.length === 0) return;

  const viewport = pageView.viewport;

  links.forEach(link => {
    const pt = viewport.convertToViewportPoint(link.rect.x, link.rect.y);
    const scaledWidth = link.rect.width * viewport.scale;
    const scaledHeight = link.rect.height * viewport.scale;

    const div = document.createElement('div');
    div.className = 'toc-link';
    div.style.left = pt[0] + 'px';
    div.style.top = (pt[1] - scaledHeight) + 'px'; 
    div.style.width = scaledWidth + 'px';
    div.style.height = (scaledHeight * 1.8) + 'px'; // Larger tap target
    
    div.onclick = () => {
       pdfViewer.currentPageNumber = link.targetPage;
    };
    
    pageView.div.appendChild(div);
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
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(148); // default fallback
  const webRef = useRef<WebView>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const pdfUri = `${FileSystem.cacheDirectory}grammar-document.pdf`;
        const fileInfo = await FileSystem.getInfoAsync(pdfUri);
        if (!fileInfo.exists) {
          await FileSystem.downloadAsync(PDF_URL, pdfUri);
        }
        
        const viewerUri = `${FileSystem.cacheDirectory}pdf-viewer.html`;
        await FileSystem.writeAsStringAsync(viewerUri, createViewerHtml(pdfUri), { encoding: FileSystem.EncodingType.UTF8 });
        setViewerUri(viewerUri);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
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



  if (error) return <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}><Text style={{ color: "#b00020" }}>{error}</Text></View>;
  if (!viewerUri) return <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}><ActivityIndicator size="large" /><Text style={{ marginTop: 12 }}>Loading document...</Text></View>;

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={{ backgroundColor: "#1565C0", padding: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: "white", fontSize: 20, fontWeight: "bold" }}>Contact: 8247829025</Text>
        <TouchableOpacity onPress={() => {
          if (showSearch) { setQuery(""); webRef.current?.injectJavaScript(`window.search("");true;`); }
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
            <TouchableOpacity onPress={() => move("prevMatch")}><MaterialIcons name="keyboard-arrow-up" size={28} /></TouchableOpacity>
            <TouchableOpacity onPress={() => move("nextMatch")}><MaterialIcons name="keyboard-arrow-down" size={28} /></TouchableOpacity>
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
            if (data.type === "search") setCount(`${data.current}/${data.total}`); 
            if (data.type === "pdf-error") setError(data.message);
            if (data.type === "pdf-ready") setTotalPages(data.pages);
            if (data.type === "page-changed") setCurrentPage(data.page);
          } catch (e) {} 
        }} 
      />


    </SafeAreaView>
  );
}