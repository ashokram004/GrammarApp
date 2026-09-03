import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  TextInput,
  TouchableOpacity,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { MaterialIcons } from "@expo/vector-icons";
import { usePreventScreenCapture } from "expo-screen-capture";
import * as FileSystem from "expo-file-system/legacy";

export default function App() {
  usePreventScreenCapture();

  const [documentUri, setDocumentUri] = useState("");
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [count, setCount] = useState("0/0");
  const [showSearch, setShowSearch] = useState(false);

  const webRef = useRef<WebView>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function forceMobileDocumentVisible() {
    webRef.current?.injectJavaScript(`
      (function () {
        function reveal(attempt) {
          var container = document.getElementById("page-container");
          var pages = document.getElementsByClassName("pf");
          if (!container || !pages.length) {
            if (attempt < 10) {
              window.setTimeout(function () {
                reveal(attempt + 1);
              }, 500);
              return;
            }

            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: "document-error",
              message: "No PDF container or pages found",
              container: !!container,
              pages: pages.length,
              bodyLength: document.body ? document.body.innerHTML.length : 0,
              url: window.location.href
            }));
            return;
          }

          var containerWidth = container.clientWidth || window.innerWidth;
          var viewer = window.pdf2htmlEX && window.pdf2htmlEX.defaultViewer;
          var firstPage = viewer && viewer.pages && viewer.pages[0];
          if (viewer && firstPage) {
            var originalWidth = firstPage.original_width || firstPage.width();
            viewer.rescale(containerWidth / originalWidth);
          }

          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: "document-ready",
            pages: pages.length,
            containerWidth: containerWidth,
            firstPageWidth: pages[0].offsetWidth,
            firstPageHeight: pages[0].offsetHeight
          }));
        }

        reveal(0);
      })();
      true;
    `);
  }

  function prepareDocument(documentHtml: string) {
    const mobileViewport =
      '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes">';

    const mobileStyles = `
      <style>
        @media screen {
          html, body, #page-container {
            max-width: 100%;
            overflow-x: hidden !important;
          }

          #page-container {
            left: 0 !important;
            right: 0 !important;
          }

          /* Prevent selecting/copying document text */
          html, body, #page-container, .pf, .pc, .t {
            -webkit-user-select: none !important;
            user-select: none !important;
            -webkit-touch-callout: none !important;
          }

          .pf {
            margin-left: 0 !important;
            margin-right: 0 !important;
          }

          .pc {
            display: block !important;
          }

          mark.search-match {
            background-color: #ffeb3b !important;
            color: #111 !important;
          }

          mark.search-match.current-match {
            background-color: #ff9800 !important;
            color: #111 !important;
          }

          /* Make TOC entries look clickable */
          .toc-entry {
            cursor: pointer !important;
            text-decoration: underline !important;
            text-decoration-thickness: 1px !important;
            text-underline-offset: 2px !important;
          }

          /*
          * Custom document scrollbar
          */
          .custom-scrollbar {
            position: fixed;
            top: 8px;
            right: 2px;
            bottom: 8px;
            width: 22px;              /* much easier to grab */
            z-index: 999999;
            pointer-events: auto;
          }

          .custom-scrollbar-thumb {
            position: absolute;
            top: 0;
            left: 4px;
            width: 14px;              /* wider visible thumb */
            min-height: 60px;
            border-radius: 10px;
            background: rgba(0, 0, 0, 0.45);
            touch-action: none;
            user-select: none;
            -webkit-user-select: none;
          }

          .custom-scrollbar-thumb:active {
            background: rgba(0, 0, 0, 0.7);
          }

          /*
          * Hide the browser's native scrollbar for the element
          * that we are controlling with our custom scrollbar.
          */
          .custom-scroll-host {
            scrollbar-width: none !important;
            -ms-overflow-style: none !important;
          }

          .custom-scroll-host::-webkit-scrollbar {
            width: 0 !important;
            height: 0 !important;
          }
        }
      </style>`;

    const mobileFitScript = `
      <script>
        (function () {

          function fitDocumentToWidth() {
            if (!window.pdf2htmlEX || !window.pdf2htmlEX.defaultViewer) {
              window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
                type: "viewer-error",
                message: "pdf2htmlEX viewer was not initialized"
              }));
              return;
            }

            var viewer = window.pdf2htmlEX.defaultViewer;
            var page = viewer.pages && viewer.pages[0];

            if (page && (page.original_width || page.width())) {
              var originalWidth = page.original_width || page.width();

              viewer.rescale(
                viewer.container.clientWidth / originalWidth
              );

              viewer.scroll_to(viewer.cur_page_idx);

              window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
                type: "viewer-ready",
                pages: viewer.pages.length,
                width: viewer.container.clientWidth,
                pageWidth: originalWidth
              }));
            }
          }

          window.addEventListener("load", function () {
            setTimeout(fitDocumentToWidth, 500);
          });

        })();
      </script>`;

    const copyProtectionScript = `
      <script>
        (function () {

          document.addEventListener("contextmenu", function (event) {
            event.preventDefault();
          });

          document.addEventListener("selectstart", function (event) {
            event.preventDefault();
          });

          document.addEventListener("copy", function (event) {
            event.preventDefault();
          });

          document.addEventListener("cut", function (event) {
            event.preventDefault();
          });

        })();
      </script>`;

    const tocScript = `
      <script>
        (function () {

          function setupTOC() {

            /*
            * Find the page containing "Table of contents".
            * This avoids hardcoding pf2.
            */
            var pages = document.querySelectorAll(".pf");
            var tocPage = null;

            for (var i = 0; i < pages.length; i++) {
              var pageText = (pages[i].textContent || "").toLowerCase();

              if (pageText.indexOf("table of contents") !== -1) {
                tocPage = pages[i];
                break;
              }
            }

            if (!tocPage) {
              setTimeout(setupTOC, 500);
              return;
            }

            var textBoxes = tocPage.querySelectorAll(".t");

            textBoxes.forEach(function (box) {

              var text = (box.textContent || "").trim();

              /*
              * TOC rows look like:
              *
              * Articles                         14
              * Tense                             29
              * Vocabulary                        48
              *
              * Get the number at the END of the row.
              */
              var match = text.match(/(\\d+)$/);

              if (!match) {
                return;
              }

              var pageNumber = parseInt(match[1], 10);

              if (!pageNumber || pageNumber < 1) {
                return;
              }

              /*
              * Prevent duplicate click listeners if setupTOC
              * happens more than once.
              */
              if (box.classList.contains("toc-entry")) {
                return;
              }

              box.classList.add("toc-entry");

              box.addEventListener("click", function () {

                if (
                  window.pdf2htmlEX &&
                  window.pdf2htmlEX.defaultViewer
                ) {

                  var viewer = window.pdf2htmlEX.defaultViewer;

                  /*
                  * IMPORTANT:
                  *
                  * Do NOT use pf + pageNumber here.
                  *
                  * pdf2htmlEX can have IDs like:
                  * pf59, pf5a, pf5b...
                  *
                  * viewer.pages is the actual ordered page list.
                  */
                  var targetIndex = pageNumber - 1;

                  if (
                    targetIndex >= 0 &&
                    targetIndex < viewer.pages.length
                  ) {
                    viewer.scroll_to(targetIndex);
                  } else {
                    console.log(
                      "TOC page number is outside document:",
                      pageNumber,
                      "Total pages:",
                      viewer.pages.length
                    );
                  }

                } else {
                  console.log("pdf2htmlEX viewer not available");
                }

              });

            });

          }

          window.addEventListener("load", function () {
            setTimeout(setupTOC, 1000);
          });

        })();
      </script>`;

    const scrollbarScript = `
      <script>
        (function () {

          var scrollElement = null;
          var scrollbar = null;
          var thumb = null;
          var dragging = false;
          var dragStartY = 0;
          var dragStartTop = 0;
          var animationFrame = null;

          function findScrollElement() {

            /*
            * Prefer pdf2htmlEX's viewer container because that is
            * normally responsible for the document scrolling.
            */
            if (
              window.pdf2htmlEX &&
              window.pdf2htmlEX.defaultViewer &&
              window.pdf2htmlEX.defaultViewer.container
            ) {
              var viewerContainer =
                window.pdf2htmlEX.defaultViewer.container;

              if (
                viewerContainer.scrollHeight >
                viewerContainer.clientHeight + 1
              ) {
                return viewerContainer;
              }
            }

            /*
            * Fallback to the normal document scrolling element.
            */
            var documentScroller = document.scrollingElement;

            if (
              documentScroller &&
              documentScroller.scrollHeight >
              documentScroller.clientHeight + 1
            ) {
              return documentScroller;
            }

            return null;
          }

          function createScrollbar() {

            if (scrollbar) {
              return true;
            }

            scrollElement = findScrollElement();

            if (!scrollElement) {
              return false;
            }

            /*
            * Hide native scrollbar.
            */
            scrollElement.classList.add("custom-scroll-host");

            scrollbar = document.createElement("div");
            scrollbar.className = "custom-scrollbar";

            thumb = document.createElement("div");
            thumb.className = "custom-scrollbar-thumb";

            scrollbar.appendChild(thumb);
            document.body.appendChild(scrollbar);

            /*
            * Dragging the thumb.
            */
            thumb.addEventListener(
              "pointerdown",
              function (event) {

                event.preventDefault();
                event.stopPropagation();

                dragging = true;

                dragStartY = event.clientY;

                dragStartTop =
                  parseFloat(thumb.style.top) || 0;

                if (thumb.setPointerCapture) {
                  try {
                    thumb.setPointerCapture(event.pointerId);
                  } catch (e) {}
                }
              }
            );

            /*
            * Move thumb while dragging.
            */
            thumb.addEventListener(
              "pointermove",
              function (event) {

                if (!dragging) {
                  return;
                }

                event.preventDefault();

                var trackHeight =
                  scrollbar.clientHeight;

                var thumbHeight =
                  thumb.offsetHeight;

                var maxThumbTop =
                  Math.max(0, trackHeight - thumbHeight);

                if (maxThumbTop <= 0) {
                  return;
                }

                var newTop =
                  dragStartTop +
                  (event.clientY - dragStartY);

                newTop = Math.max(
                  0,
                  Math.min(maxThumbTop, newTop)
                );

                var ratio =
                  newTop / maxThumbTop;

                var maxScroll =
                  scrollElement.scrollHeight -
                  scrollElement.clientHeight;

                scrollElement.scrollTop =
                  ratio * maxScroll;

                updateThumb();
              }
            );

            /*
            * Stop dragging.
            */
            function stopDragging(event) {

              if (!dragging) {
                return;
              }

              dragging = false;

              if (
                event &&
                thumb.releasePointerCapture
              ) {
                try {
                  thumb.releasePointerCapture(
                    event.pointerId
                  );
                } catch (e) {}
              }
            }

            thumb.addEventListener(
              "pointerup",
              stopDragging
            );

            thumb.addEventListener(
              "pointercancel",
              stopDragging
            );

            /*
            * Tapping the scrollbar track jumps toward
            * that location.
            */
            scrollbar.addEventListener(
              "pointerdown",
              function (event) {

                if (event.target === thumb) {
                  return;
                }

                var rect =
                  scrollbar.getBoundingClientRect();

                var clickY =
                  event.clientY - rect.top;

                var trackHeight =
                  scrollbar.clientHeight;

                var thumbHeight =
                  thumb.offsetHeight;

                var maxThumbTop =
                  Math.max(0, trackHeight - thumbHeight);

                var targetTop =
                  clickY - (thumbHeight / 2);

                targetTop = Math.max(
                  0,
                  Math.min(maxThumbTop, targetTop)
                );

                var ratio =
                  maxThumbTop > 0
                    ? targetTop / maxThumbTop
                    : 0;

                var maxScroll =
                  scrollElement.scrollHeight -
                  scrollElement.clientHeight;

                scrollElement.scrollTop =
                  ratio * maxScroll;

                updateThumb();
              }
            );

            /*
            * Update scrollbar whenever the document scrolls.
            */
            scrollElement.addEventListener(
              "scroll",
              scheduleUpdate,
              { passive: true }
            );

            window.addEventListener(
              "resize",
              scheduleUpdate
            );

            updateThumb();

            return true;
          }

          function updateThumb() {

            if (
              !scrollElement ||
              !scrollbar ||
              !thumb
            ) {
              return;
            }

            var scrollHeight =
              scrollElement.scrollHeight;

            var clientHeight =
              scrollElement.clientHeight;

            var maxScroll =
              scrollHeight - clientHeight;

            if (maxScroll <= 0) {
              scrollbar.style.display = "none";
              return;
            }

            scrollbar.style.display = "block";

            var trackHeight =
              scrollbar.clientHeight;

            /*
            * Thumb size represents how much of the
            * document is currently visible.
            */
            var thumbHeight =
              Math.max(
                50,
                trackHeight *
                (clientHeight / scrollHeight)
              );

            thumbHeight =
              Math.min(trackHeight, thumbHeight);

            thumb.style.height =
              thumbHeight + "px";

            var maxThumbTop =
              Math.max(
                0,
                trackHeight - thumbHeight
              );

            var ratio =
              maxScroll > 0
                ? scrollElement.scrollTop / maxScroll
                : 0;

            thumb.style.top =
              (ratio * maxThumbTop) + "px";
          }

          function scheduleUpdate() {

            if (animationFrame) {
              return;
            }

            animationFrame =
              requestAnimationFrame(function () {

                animationFrame = null;

                updateThumb();
              });
          }

          function initialize() {

            if (createScrollbar()) {
              return;
            }

            /*
            * pdf2htmlEX may not have finished creating
            * all of its pages yet.
            */
            setTimeout(initialize, 500);
          }

          window.addEventListener(
            "load",
            function () {
              setTimeout(initialize, 1000);
            }
          );

        })();
      </script>`;

    const searchScript = `
      <script>
        (function () {

          var matches = [];
          var currentMatch = -1;
          var textBoxes = null;
          var textValues = null;

          function reportSearch() {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: "search",
              current: matches.length ? currentMatch + 1 : 0,
              total: matches.length
            }));
          }

          function clearMatches() {

            document
              .querySelectorAll(".search-match")
              .forEach(function (mark) {

                var parent = mark.parentNode;

                if (parent) {

                  parent.replaceChild(
                    document.createTextNode(
                      mark.textContent || ""
                    ),
                    mark
                  );

                  parent.normalize();
                }

              });

            matches = [];
            currentMatch = -1;
          }

          function buildTextIndex() {

            if (textBoxes) {
              return;
            }

            textBoxes =
              Array.prototype.slice.call(
                document.getElementsByClassName("t")
              );

            textValues =
              textBoxes.map(function (textBox) {

                return (
                  textBox.textContent || ""
                ).toLocaleLowerCase();

              });
          }

          window.search = function (term) {

            clearMatches();

            term =
              String(term || "").trim();

            if (!term) {
              reportSearch();
              return;
            }

            buildTextIndex();

            var normalizedTerm =
              term.toLocaleLowerCase();

            textBoxes.forEach(
              function (textBox, boxIndex) {

                if (
                  textValues[boxIndex]
                    .indexOf(normalizedTerm) === -1
                ) {
                  return;
                }

                var walker =
                  document.createTreeWalker(
                    textBox,
                    NodeFilter.SHOW_TEXT
                  );

                var textNodes = [];
                var node;

                while (
                  (node = walker.nextNode())
                ) {
                  textNodes.push(node);
                }

                textNodes.forEach(
                  function (textNode) {

                    var value =
                      textNode.nodeValue || "";

                    var fragment =
                      document.createDocumentFragment();

                    var lastIndex = 0;
                    var found = false;

                    var lowerValue =
                      value.toLocaleLowerCase();

                    var lowerTerm =
                      normalizedTerm;

                    var offset =
                      lowerValue.indexOf(
                        lowerTerm,
                        lastIndex
                      );

                    while (offset !== -1) {

                      found = true;

                      var match =
                        value.slice(
                          offset,
                          offset + term.length
                        );

                      fragment.appendChild(
                        document.createTextNode(
                          value.slice(
                            lastIndex,
                            offset
                          )
                        )
                      );

                      var mark =
                        document.createElement("mark");

                      mark.className =
                        "search-match";

                      mark.textContent =
                        match;

                      fragment.appendChild(mark);

                      matches.push(mark);

                      lastIndex =
                        offset + match.length;

                      offset =
                        lowerValue.indexOf(
                          lowerTerm,
                          lastIndex
                        );
                    }

                    if (found) {

                      fragment.appendChild(
                        document.createTextNode(
                          value.slice(lastIndex)
                        )
                      );

                      textNode.parentNode.replaceChild(
                        fragment,
                        textNode
                      );
                    }

                  }
                );

              }
            );

            if (matches.length) {

              currentMatch = 0;

              matches[0].classList.add("current-match");

              matches[0].scrollIntoView({
                block: "center"
              });
            }

            reportSearch();
          };

          window.nextMatch = function () {

            if (!matches.length) {
              return;
            }

            currentMatch =
              (currentMatch + 1) %
              matches.length;

            matches.forEach(function (match) {
              match.classList.remove("current-match");
            });
            matches[currentMatch].classList.add("current-match");

            matches[currentMatch].scrollIntoView({
              block: "center"
            });

            reportSearch();
          };

          window.prevMatch = function () {

            if (!matches.length) {
              return;
            }

            currentMatch =
              (currentMatch - 1 + matches.length) %
              matches.length;

            matches.forEach(function (match) {
              match.classList.remove("current-match");
            });
            matches[currentMatch].classList.add("current-match");

            matches[currentMatch].scrollIntoView({
              block: "center"
            });

            reportSearch();
          };

        })();
      </script>`;

    return documentHtml
      .replace(
        /<head>/i,
        `<head>${mobileViewport}${mobileStyles}`
      )
      .replace(
        /<\/body>/i,
        `${mobileFitScript}${tocScript}${scrollbarScript}${copyProtectionScript}${searchScript}</body>`
      );
  }

  useEffect(() => {
    async function load() {
      try {
        console.log("[GrammarApp] Downloading document HTML...");

        const response = await fetch(
          "https://drive.google.com/uc?export=download&id=1xjlLFrDG9GxesgK8ButdfHtkZtOPH9Po"
        );

        if (!response.ok) {
          throw new Error(`Download failed with HTTP ${response.status}`);
        }

        const downloadedHtml = await response.text();
        console.log("[GrammarApp] Response:", {
          status: response.status,
          contentType: response.headers.get("content-type"),
          length: downloadedHtml.length,
          startsWith: downloadedHtml.slice(0, 80),
        });

        if (!downloadedHtml.toLowerCase().includes("<html")) {
          throw new Error("Google Drive returned something other than HTML");
        }

        const text = prepareDocument(downloadedHtml);
        const documentUri = `${FileSystem.cacheDirectory}grammar-document.html`;

        console.log("[GrammarApp] Writing prepared document to cache...");
        await FileSystem.writeAsStringAsync(documentUri, text, {
          encoding: FileSystem.EncodingType.UTF8,
        });

        console.log("[GrammarApp] Prepared document:", text.length);

        console.log("[GrammarApp] Cached document:", documentUri);
        setDocumentUri(documentUri);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[GrammarApp] Document load failed:", message, e);
        setLoadError(message);
      }
    }

    load();
  }, []);

  function search(text: string) {
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
    }

    searchTimer.current = setTimeout(() => {
      webRef.current?.injectJavaScript(
        `search(${JSON.stringify(text)});true;`
      );
    }, 250);
  }

  function next() {
    webRef.current?.injectJavaScript(`nextMatch();true;`);
  }

  function previous() {
    webRef.current?.injectJavaScript(`prevMatch();true;`);
  }

  if (loadError) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          padding: 24,
        }}
      >
        <Text style={{ fontSize: 18, textAlign: "center", color: "#B00020" }}>
          Unable to load the document.
        </Text>
        <Text style={{ marginTop: 10, textAlign: "center" }}>{loadError}</Text>
      </View>
    );
  }

  if (!documentUri) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>

      <View
        style={{
          backgroundColor: "#1565C0",
          paddingHorizontal: 16,
          paddingVertical: 14,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          elevation:5,
          shadowColor:"#000",
          shadowOpacity:0.15,
          shadowRadius:6,
        }}
      >

        <Text
          style={{
            color: "white",
            fontSize: 22,
            fontWeight: "bold",
          }}
        >
          Contact: 8247829025
        </Text>

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
          }}
        >

          <TouchableOpacity
            onPress={() => {

                if(showSearch){

                    setQuery("");

                    search("");

                }

                setShowSearch(!showSearch);

            }}
          >
            <MaterialIcons
              name={showSearch ? "close" : "search"}
              color="white"
              size={28}
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={{ marginLeft: 15 }}
          >
            <MaterialIcons
              name="more-vert"
              color="white"
              size={28}
            />
          </TouchableOpacity>

        </View>

      </View>

      {
        showSearch && (

        <View
        style={{
        backgroundColor:"#1565C0",
        paddingHorizontal:16,
        paddingBottom:15
        }}
        >

        <View
        style={{
        backgroundColor:"white",
        borderRadius:12,
        flexDirection:"row",
        alignItems:"center",
        paddingHorizontal:10,
        height:48
        }}
        >

        <MaterialIcons
        name="search"
        size={24}
        color="#666"
        />

        <TextInput

        style={{
        flex:1,
        marginLeft:10,
        fontSize:17
        }}

        placeholder="Search..."

        value={query}

        onChangeText={(t)=>{

        setQuery(t);

        search(t);

        }}

        />

        <Text
        style={{
        marginHorizontal:10,
        color:"#666",
        fontWeight:"600"
        }}
        >

        {count}

        </Text>

        <TouchableOpacity
        onPress={previous}
        >

        <MaterialIcons
        name="keyboard-arrow-up"
        size={28}
        />

        </TouchableOpacity>

        <TouchableOpacity
        onPress={next}
        >

        <MaterialIcons
        name="keyboard-arrow-down"
        size={28}
        />

        </TouchableOpacity>

        </View>

        </View>

        )
        }

      <WebView
        ref={webRef}
        originWhitelist={["*"]}
        source={{ uri: documentUri }}
        style={{ flex: 1 }}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowFileAccess={true}
        allowFileAccessFromFileURLs={true}
        allowUniversalAccessFromFileURLs={true}
        onMessage={(event) => {
          console.log("[GrammarApp] WebView message:", event.nativeEvent.data);
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === "search") {
              setCount(`${data.current}/${data.total}`);
            }
          } catch (e) {
            console.log(e);
          }
        }}
        onLoadStart={() => console.log("[GrammarApp] WebView load started")}
        onLoad={() => console.log("[GrammarApp] WebView load completed")}
        onLoadEnd={() => console.log("[GrammarApp] WebView load ended")}
        onNavigationStateChange={(state) => {
          console.log("[GrammarApp] WebView navigation:", {
            loading: state.loading,
            url: state.url,
          });
          if (!state.loading) {
            setTimeout(forceMobileDocumentVisible, 3000);
          }
        }}
        onError={(event) => {
          console.error("[GrammarApp] WebView error:", event.nativeEvent);
        }}
        onHttpError={(event) => {
          console.error("[GrammarApp] WebView HTTP error:", event.nativeEvent);
        }}
        onRenderProcessGone={(event) => {
          console.error(
            "[GrammarApp] WebView renderer stopped:",
            event.nativeEvent
          );
        }}
      />

    </SafeAreaView>
  );
}
