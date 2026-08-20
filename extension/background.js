const ext =
    typeof browser !== "undefined"
        ? browser
        : chrome;
async function fetchWithTimeout(
    url,
    options = {},
    timeoutMs = 10000
) {
    const controller =
        new AbortController();

    const timeout =
        setTimeout(() => {
            controller.abort();
        }, timeoutMs);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

async function cacheOneImage(imageUrl) {
    try {
        console.log(
            "Fetching extension image:",
            imageUrl
        );

        const response =
            await fetchWithTimeout(
                imageUrl,
                {
                    credentials: "include",
                    cache: "force-cache",
                },
                10000
            );

        if (!response.ok) {
            console.warn(
                "Could not fetch image:",
                response.status,
                imageUrl
            );

            return;
        }

        const blob =
            await response.blob();

        const contentType =
            blob.type ||
            response.headers.get(
                "content-type"
            ) ||
            "image/jpeg";

        const buffer =
            await blob.arrayBuffer();

        console.log(
            "Uploading extension image:",
            imageUrl
        );

        const uploadResponse =
            await fetchWithTimeout(
                "http://localhost:3000/api/cache-image" +
                `?url=${encodeURIComponent(imageUrl)}` +
                `&contentType=${encodeURIComponent(contentType)}`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/octet-stream",
                    },

                    body: buffer,
                },
                15000
            );

        if (!uploadResponse.ok) {
            console.warn(
                "Backend rejected image:",
                uploadResponse.status,
                imageUrl
            );

            return;
        }

        console.log(
            "Finished extension image:",
            imageUrl
        );
    } catch (error) {
        console.warn(
            "Skipping extension image:",
            imageUrl,
            error
        );
    }
}
async function showLoadingOverlay(tabId) {
    await ext.scripting.executeScript({
        target: {
            tabId,
        },

        func: () => {
            if (
                document.getElementById(
                    "__article_fixer_loading"
                )
            ) {
                return;
            }

            const overlay =
                document.createElement("div");

            overlay.id =
                "__article_fixer_loading";

            overlay.innerHTML = `
                <div
                    style="
                        background: white;
                        padding: 20px 24px;
                        border-radius: 14px;
                        box-shadow: 0 4px 20px rgba(0,0,0,0.25);
                        font-family: system-ui, sans-serif;
                        font-size: 16px;
                        color: black;
                        display: flex;
                        align-items: center;
                        gap: 12px;
                    "
                >
                    <div
                        style="
                            width: 20px;
                            height: 20px;
                            border: 3px solid #ccc;
                            border-top-color: #333;
                            border-radius: 50%;
                            animation: articleFixerSpin 0.8s linear infinite;
                        "
                    ></div>

                    Sending to Article Fixer...
                </div>
            `;

            Object.assign(
                overlay.style,
                {
                    position: "fixed",
                    inset: "0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background:
                        "rgba(0, 0, 0, 0.18)",
                    zIndex: "2147483647",
                }
            );

            const style =
                document.createElement(
                    "style"
                );

            style.id =
                "__article_fixer_loading_style";

            style.textContent = `
                @keyframes articleFixerSpin {
                    to {
                        transform: rotate(360deg);
                    }
                }
            `;

            document.head.appendChild(
                style
            );

            document.body.appendChild(
                overlay
            );
        },
    });
}
async function hideLoadingOverlay(tabId) {
    try {
        await ext.scripting.executeScript({
            target: {
                tabId,
            },

            func: () => {
                document
                    .getElementById(
                        "__article_fixer_loading"
                    )
                    ?.remove();

                document
                    .getElementById(
                        "__article_fixer_loading_style"
                    )
                    ?.remove();
            },
        });
    } catch {
        // Page may have closed or navigated away.
    }
}

ext.action.onClicked.addListener(
    async (tab) => {
        if (!tab.id) {
            return;
        }

        await showLoadingOverlay(
            tab.id
        );

        try {
            const [{ result }] =
                await ext.scripting.executeScript({
                    target: {
                        tabId: tab.id,
                    },

                    func: () => {
                        const clone =
                            document.documentElement.cloneNode(true);

                        clone
                            .querySelector(
                                "#__article_fixer_loading"
                            )
                            ?.remove();

                        clone
                            .querySelector(
                                "#__article_fixer_loading_style"
                            )
                            ?.remove();

                        const clonedImages =
                            clone.querySelectorAll("img");

                        const originalImages =
                            document.querySelectorAll("img");

                        const thumbnailUrl =
                            document
                                .querySelector('meta[property="og:image"]')
                                ?.getAttribute("content") ??
                            document
                                .querySelector('meta[name="twitter:image"]')
                                ?.getAttribute("content") ??
                            null;

                        clonedImages.forEach(
                            (img, index) => {
                                const original =
                                    originalImages[index];

                                if (
                                    original?.currentSrc
                                ) {
                                    img.setAttribute(
                                        "src",
                                        original.currentSrc
                                    );
                                }

                                img.removeAttribute(
                                    "srcset"
                                );

                                img.removeAttribute(
                                    "data-srcset"
                                );
                            }
                        );

                        return {
                            url: location.href,
                            html: clone.outerHTML,
                            thumbnailUrl,

                            images: [
                                ...Array.from(document.images)
                                    .map(img => img.currentSrc || img.src)
                                    .filter(Boolean),

                                ...(thumbnailUrl
                                    ? [thumbnailUrl]
                                    : []),
                            ],
                        };
                    },
                });

            if (!result) {
                return;
            }

            const uniqueImages =
                [...new Set(result.images)];

            const batchSize = 6;

            for (
                let i = 0;
                i < uniqueImages.length;
                i += batchSize
            ) {
                const batch =
                    uniqueImages.slice(
                        i,
                        i + batchSize
                    );

                await Promise.allSettled(
                    batch.map(cacheOneImage)
                );
            }

            console.log(
                "Finished caching extension images"
            );

            console.log(
                "Sending article HTML to backend"
            );

            const response =
                await fetch(
                    "http://localhost:3000/api/extract-html",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json",
                        },

                        body: JSON.stringify({
                            url: result.url,
                            html: result.html,
                        }),
                    }
                );

            console.log(
                "Article extraction response:",
                response.status
            );

            if (!response.ok) {
                console.error(
                    "Extraction failed:",
                    response.status
                );

                return;
            }

            const {
                id,
            } = await response.json();

            await ext.tabs.create({
                url:
                    "http://localhost:5173/" +
                    `?articleId=${encodeURIComponent(id)}`,
            });
        } catch (error) {
            console.error(
                "Article Fixer failed:",
                error
            );
        } finally {
            await hideLoadingOverlay(
                tab.id
            );
        }
    }
);
