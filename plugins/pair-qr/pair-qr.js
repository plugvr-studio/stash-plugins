(function () {
  "use strict";

  try {
    load();
  } catch (err) {
    try {
      console.error("Pair QR failed to load.", err);
    } catch (ignored) {
      return;
    }
  }

  function load() {
    const PluginApi = window.PluginApi;
    if (
      !PluginApi ||
      !PluginApi.React ||
      typeof PluginApi.React.createElement !== "function" ||
      typeof PluginApi.React.Component !== "function" ||
      !PluginApi.patch ||
      typeof PluginApi.patch.after !== "function"
    ) {
      return;
    }

    const React = PluginApi.React;
    const e = React.createElement;

    // Without a username Stash has no login: it answers devices on its own
    // network without a key, and can't make one. A key left over from removed
    // credentials works again as soon as any are set, until a new key is
    // generated. So without a username the code never carries a key.
    const CURRENT_KEY_QUERY = `
      query PairQrCurrentKey {
        configuration {
          general {
            apiKey
            username
          }
        }
      }
    `;

    const NO_KEY_MESSAGE =
      "Stash has no API key yet. Use the Generate button on the API key row to create one.";

    const CONTACT_URL = "https://github.com/plugvr-studio/stash-plugins/issues";

    // Placeholders in the QR text, replaced when the code is drawn. url is the
    // address Stash is open at, e.g. http://192.168.1.100:9999; name is what the
    // Name field holds (PlugVR lists the server under it, or under its host when
    // it is empty).
    const PLACEHOLDERS = /\{(url|apiKey|name)\}/g;
    const URL_PLACEHOLDER = "{url}";
    const API_KEY_PLACEHOLDER = "{apiKey}";
    const NAME_PLACEHOLDER = "{name}";

    // The PlugVR symbol, flat cut (the brand's version for 16 and 20 px), cropped
    // like the favicon to the central 80 units.
    const PLUGVR_ICON =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="14 14 80 80">' +
          '<g transform="translate(54 57) rotate(-15) scale(0.94) translate(-54 -57)">' +
          '<path fill="#ECEEF2" d="M47.5 28h0.0a3.5 3.5 0 0 1 3.5 3.5v13.0a3.5 3.5 0 0 1 -3.5 3.5h-0.0a3.5 3.5 0 0 1 -3.5 -3.5v-13.0a3.5 3.5 0 0 1 3.5 -3.5ZM60.5 28h0.0a3.5 3.5 0 0 1 3.5 3.5v13.0a3.5 3.5 0 0 1 -3.5 3.5h-0.0a3.5 3.5 0 0 1 -3.5 -3.5v-13.0a3.5 3.5 0 0 1 3.5 -3.5Z"/>' +
          '<path fill="#4F8CFF" fill-rule="evenodd" d="M37 49a5 5 0 0 1 5-5h24a5 5 0 0 1 5 5v15a14 14 0 0 1-14 14h-6a14 14 0 0 1-14-14ZM48 52v18l16-9Z"/>' +
          '<path fill="none" stroke="#4F8CFF" stroke-width="6" stroke-linecap="round" d="M54 78c0 6 7 4 9 8"/>' +
          "</g></svg>"
      );

    // Texts the editor can reset to. The first is the default. PlugVR's is what
    // its QrSetup.parse reads: url, and optionally apiKey and name (blank = none).
    // keylessText is encoded instead when Stash has no login: PlugVR's setup
    // schema wants apiKey left out then, not empty.
    const PRESETS = [
      {
        name: "PlugVR",
        caption: "PlugVR pairing",
        icon: PLUGVR_ICON,
        text: '{"url":"{url}","apiKey":"{apiKey}","name":"{name}"}',
        keylessText: '{"url":"{url}","name":"{name}"}',
      },
    ];

    // Warehouse words and slang. The name starts as one of them, picked at random
    // each time the page loads, so each scan gives PlugVR a name to list the
    // server under. An empty field gets one too (fallbackName below).
    const NAMES = [
      "Forklift", "Pallet Jack", "Loading Dock", "Cross Dock", "Pick Face",
      "Golden Zone", "Mezzanine", "Shrink Wrap", "Conveyor", "Dock Leveler",
      "Staging Lane", "Cycle Count", "Putaway", "Backorder", "Overstock",
      "Dead Stock", "Fast Mover", "Cold Store", "Reach Truck", "Order Picker",
      "Wave Pick", "End Cap", "Bill of Lading", "Packing Slip", "Load Bar",
      "Dunnage", "Skid", "Gaylord", "Pick Ticket", "Yard Dog",
      "Yard Goat", "Wheel Chock", "Cherry Picker", "Hand Truck", "Kitting",
      "Drop Trailer", "Floor Load", "Slip Sheet", "Clamp Truck", "Hi-Lo",
      "Tow Motor", "Walkie", "Lumper", "Tugger", "Deadhead",
      "Hot Pick", "Short Pick", "Cube Out", "Dock to Stock", "Swing Shift",
    ];

    function randomName() {
      return NAMES[Math.floor(Math.random() * NAMES.length)] || NAMES[0];
    }

    // A random name other than current (case ignored), for the dice button.
    function anotherName(current) {
      const now = String(current || "").trim().toLowerCase();
      const others = NAMES.filter(function (item) {
        return item.toLowerCase() !== now;
      });
      return others[Math.floor(Math.random() * others.length)] || NAMES[0];
    }

    // The text and name being edited. They live as long as the page does: closing
    // the dialog keeps them, a reload brings back the defaults. Nothing is saved.
    let editedText = PRESETS[0].text;
    let editedName = randomName();
    // The name used while the field is empty, shown there in grey. Picked once
    // per page load, so the code does not change while the field stays empty.
    const fallbackName = randomName();

    function codeName(name) {
      return String(name || "").trim() ? name : fallbackName;
    }

    function errorText(err, fallback) {
      try {
        if (typeof err === "string" && err) {
          return err;
        }
        if (err && typeof err.message === "string" && err.message) {
          return err.message;
        }
      } catch (ignored) {
        return fallback;
      }
      return fallback;
    }

    function isComponent(type) {
      if (typeof type === "function") {
        return true;
      }
      return Boolean(type && typeof type === "object" && type.$$typeof);
    }

    // Render failures stay inside this boundary. Stash's own element is a sibling,
    // so a plugin error cannot blank the settings page.
    class PluginBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false, detail: "" };
      }

      static getDerivedStateFromError(err) {
        return { failed: true, detail: errorText(err, "") };
      }

      componentDidCatch(err) {
        try {
          console.error(this.props.label + " failed.", err);
        } catch (ignored) {
          return;
        }
      }

      render() {
        if (this.state.failed) {
          return e(
            "div",
            { className: "alert alert-danger pair-qr-failure", role: "alert" },
            e(
              "p",
              null,
              this.props.label + " failed and was disabled so Stash can keep working."
            ),
            this.state.detail
              ? e("p", { className: "pair-qr-failure-detail" }, this.state.detail)
              : null,
            e(
              "p",
              null,
              "Report this to the plugin developer on ",
              e(
                "a",
                {
                  href: CONTACT_URL,
                  target: "_blank",
                  rel: "noopener noreferrer",
                },
                "GitHub"
              ),
              "."
            )
          );
        }
        return this.props.children;
      }
    }

    function pluginComponent(owner, name) {
      try {
        const value = owner && owner[name];
        return isComponent(value) ? value : null;
      } catch (err) {
        console.error("Pair QR could not read " + name + ".", err);
        return null;
      }
    }

    function bootstrap(name) {
      try {
        const libraries = PluginApi.libraries;
        return pluginComponent(libraries && libraries.Bootstrap, name);
      } catch (err) {
        console.error("Pair QR could not read Bootstrap.", err);
        return null;
      }
    }

    function stashGraphQL(query, variables) {
      try {
        return fetch("/graphql", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: query, variables: variables }),
        }).then(function (response) {
          return response.json().then(function (body) {
            if (!body || typeof body !== "object") {
              throw new Error("Stash returned an unexpected response.");
            }
            const errors = Array.isArray(body.errors)
              ? body.errors
              : body.errors
                ? [body.errors]
                : [];
            if (errors.length) {
              throw new Error(
                errors
                  .map(function (item) {
                    if (typeof item === "string" && item) {
                      return item;
                    }
                    if (item && typeof item.message === "string" && item.message) {
                      return item.message;
                    }
                    return "Unknown error";
                  })
                  .join("\n")
              );
            }
            if (!response.ok) {
              throw new Error("Stash request failed (" + response.status + ").");
            }
            return body.data;
          });
        });
      } catch (err) {
        return Promise.reject(err);
      }
    }

    // Wraps an event handler so a failure is logged instead of thrown.
    function guard(action, handler) {
      return function () {
        try {
          return handler.apply(this, arguments);
        } catch (err) {
          console.error("Pair QR could not " + action + ".", err);
          return undefined;
        }
      };
    }

    function serverUrl() {
      try {
        return window.location.origin || "";
      } catch (err) {
        return "";
      }
    }

    // Whether Stash is open at an address that means "this device": another
    // device scanning a code with it would connect to itself. Only literal
    // addresses can be checked; a page cannot look up what a name resolves to.
    function isLoopbackPage() {
      let host = "";
      try {
        host = String(window.location.hostname || "").toLowerCase();
      } catch (err) {
        return false;
      }
      if (host.charAt(0) === "[") {
        host = host.slice(1, -1);
      }
      host = host.replace(/\.$/, "");
      return (
        host === "localhost" ||
        /\.localhost$/.test(host) ||
        /^127\.\d+\.\d+\.\d+$/.test(host) ||
        host === "0.0.0.0" ||
        host === "::1" ||
        host === "::" ||
        /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)
      );
    }

    // Whether the text is JSON once its placeholders are filled, so the values
    // must be escaped as JSON string content (a name may hold a quote).
    function isJsonText(text) {
      try {
        JSON.parse(text.replace(PLACEHOLDERS, "x"));
        return true;
      } catch (err) {
        return false;
      }
    }

    // One pass, so a value that happens to contain a placeholder stays as it is.
    function fillPlaceholders(text, values) {
      const json = isJsonText(text);
      return text.replace(PLACEHOLDERS, function (match, name) {
        const value = values[name];
        return json ? JSON.stringify(value).slice(1, -1) : value;
      });
    }

    function presetFor(text) {
      for (let i = 0; i < PRESETS.length; i += 1) {
        if (PRESETS[i].text === text) {
          return PRESETS[i];
        }
      }
      return null;
    }

    // qrcode.js throws a string when the text does not fit in version 40.
    function isTooLong(err) {
      return typeof err === "string" && err.indexOf("code length overflow") === 0;
    }

    function qrDataUrl(text) {
      const factory = window.qrcode;
      if (typeof factory !== "function") {
        throw new Error("QR library failed to load.");
      }
      if (factory.stringToBytesFuncs && factory.stringToBytesFuncs["UTF-8"]) {
        factory.stringToBytes = factory.stringToBytesFuncs["UTF-8"];
      }
      const code = factory(0, "M");
      code.addData(text);
      code.make();
      // 8 px modules, as before, until the code gets dense; then smaller, so a
      // long text does not draw a huge image on every keystroke. CSS scales it.
      const cellSize = Math.max(
        2,
        Math.min(8, Math.floor(640 / code.getModuleCount()))
      );
      const dataUrl = code.createDataURL(cellSize, 2);
      if (!dataUrl || dataUrl.indexOf("data:image/gif;base64,") !== 0) {
        throw new Error("QR encoder returned an unexpected image.");
      }
      return dataUrl;
    }

    // What the frame shows for this text: { imageUrl, keyless }, { message } or
    // { error }. keyless means the text asks for the key but Stash has no login,
    // so the code goes without it.
    // key is { status: "loading" | "ready" | "error", value, hasUsername, error }.
    function qrFor(text, key, name) {
      if (!text) {
        return { message: "Type the text for the QR code." };
      }
      let encoded = text;
      let keyless = false;
      if (text.indexOf(API_KEY_PLACEHOLDER) !== -1) {
        if (key.status === "loading") {
          return { message: "Loading…" };
        }
        if (key.status === "error") {
          return { error: key.error };
        }
        if (!key.hasUsername) {
          keyless = true;
          const preset = presetFor(text);
          if (preset && preset.keylessText) {
            encoded = preset.keylessText;
          }
        } else if (!key.value) {
          return { message: NO_KEY_MESSAGE };
        }
      }
      const url = serverUrl();
      if (!url && encoded.indexOf(URL_PLACEHOLDER) !== -1) {
        return { error: "Could not read the server URL." };
      }
      try {
        return {
          imageUrl: qrDataUrl(
            fillPlaceholders(encoded, {
              url: url,
              apiKey: keyless ? "" : key.value,
              name: name,
            })
          ),
          keyless: keyless,
        };
      } catch (err) {
        if (isTooLong(err)) {
          return { message: "This text is too long for a QR code." };
        }
        return { error: errorText(err, "Could not draw the QR code.") };
      }
    }

    function qrFrame(qr, preset) {
      if (qr.imageUrl) {
        return e(
          "div",
          { className: "pair-qr-frame" },
          e("img", {
            src: qr.imageUrl,
            alt: preset ? preset.caption + " QR code" : "QR code with custom text",
          })
        );
      }
      return e(
        "div",
        { className: "pair-qr-frame pair-qr-frame-empty" },
        qr.error
          ? e("div", { className: "alert alert-danger", role: "alert" }, qr.error)
          : e("p", { className: "pair-qr-message" }, qr.message)
      );
    }

    // A die showing five, in the text colour.
    function diceIcon() {
      const pips = [
        [5.5, 5.5],
        [10.5, 5.5],
        [8, 8],
        [5.5, 10.5],
        [10.5, 10.5],
      ];
      return e(
        "svg",
        {
          className: "pair-qr-dice-icon",
          viewBox: "0 0 16 16",
          width: 16,
          height: 16,
          "aria-hidden": "true",
          focusable: "false",
        },
        e("rect", {
          x: 1.75,
          y: 1.75,
          width: 12.5,
          height: 12.5,
          rx: 2.5,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
        }),
        pips.map(function (pip) {
          return e("circle", {
            key: pip[0] + "," + pip[1],
            cx: pip[0],
            cy: pip[1],
            r: 1.2,
            fill: "currentColor",
          });
        })
      );
    }

    // url with a sample LAN host in place of its own, keeping the scheme and port.
    function sampleLanUrl(url) {
      try {
        const sample = new URL(url);
        sample.hostname = "192.168.1.20";
        return sample.origin;
      } catch (err) {
        return "http://192.168.1.20:9999";
      }
    }

    function loopbackWarning(url) {
      return e(
        "div",
        { className: "alert alert-warning pair-qr-warning" },
        e("strong", null, "Other devices can't reach this address."),
        " This code holds ",
        e("code", null, url),
        ", which on a headset or phone means the device itself. Open Stash at this computer's network address, such as ",
        e("code", null, sampleLanUrl(url)),
        ", and show the code from there. Or select Edit and type that address in place of ",
        e("code", null, URL_PLACEHOLDER),
        "."
      );
    }

    function keylessNotice() {
      return e(
        "div",
        { className: "alert alert-info pair-qr-notice" },
        e("strong", null, "Works only on the same network as Stash."),
        " Stash has no username and password, so this code has no API key. To pair from other networks too, set a username and password in Settings → Security, then generate an API key: the code will carry it."
      );
    }

    const EDITOR_ID = "pair-qr-editor";
    const NAME_ID = "pair-qr-name";
    const NAME_HINT_ID = "pair-qr-name-hint";
    const TEXT_ID = "pair-qr-text";
    const HINT_ID = "pair-qr-hint";

    function PairQrPanel() {
      const [key, setKey] = React.useState({
        status: "loading",
        value: "",
        hasUsername: false,
        error: "",
      });
      const [text, setText] = React.useState(editedText);
      const [name, setName] = React.useState(editedName);
      const [editing, setEditing] = React.useState(false);
      const textArea = React.useRef(null);

      React.useEffect(function () {
        let cancelled = false;
        function fail(err) {
          if (!cancelled) {
            setKey({
              status: "error",
              value: "",
              hasUsername: false,
              error: errorText(err, "Could not read the current API key."),
            });
          }
        }
        try {
          stashGraphQL(CURRENT_KEY_QUERY)
            .then(function (data) {
              if (cancelled) {
                return;
              }
              const general =
                data && data.configuration && data.configuration.general;
              const apiKey = general && general.apiKey;
              const username = general && general.username;
              setKey({
                status: "ready",
                value: typeof apiKey === "string" ? apiKey : "",
                hasUsername: typeof username === "string" && username !== "",
                error: "",
              });
            })
            .catch(fail);
        } catch (err) {
          fail(err);
        }
        return function () {
          cancelled = true;
        };
      }, []);

      React.useEffect(
        function () {
          if (!editing) {
            return;
          }
          try {
            const field = textArea.current;
            if (field) {
              field.focus();
              field.setSelectionRange(field.value.length, field.value.length);
            }
          } catch (err) {
            console.error("Pair QR could not focus the text.", err);
          }
        },
        [editing]
      );

      const qr = React.useMemo(
        function () {
          return qrFor(text, key, codeName(name));
        },
        [text, key, name]
      );
      const preset = presetFor(text);
      // The name is in a preset's code but out of sight until Edit, so the
      // caption says it.
      const shownName =
        preset && text.indexOf(NAME_PLACEHOLDER) !== -1
          ? String(codeName(name)).trim()
          : "";
      const captionText = preset
        ? preset.caption + (shownName ? " · " + shownName : "")
        : "Custom text";
      const loopback =
        text.indexOf(URL_PLACEHOLDER) !== -1 && isLoopbackPage()
          ? serverUrl()
          : "";

      function changeText(value) {
        editedText = value;
        setText(value);
      }

      function changeName(value) {
        editedName = value;
        setName(value);
      }

      const editor = editing
        ? e(
            "div",
            { className: "pair-qr-editor", id: EDITOR_ID },
            e("label", { className: "pair-qr-label", htmlFor: NAME_ID }, "Name"),
            e(
              "div",
              { className: "pair-qr-name-row" },
              e("input", {
                id: NAME_ID,
                type: "text",
                className: "form-control pair-qr-name",
                value: name,
                placeholder: fallbackName,
                autoComplete: "off",
                spellCheck: false,
                "aria-describedby": NAME_HINT_ID,
                onChange: guard("change the name", function (event) {
                  changeName(event.target.value);
                }),
              }),
              e(
                "button",
                {
                  type: "button",
                  className: "btn btn-secondary pair-qr-dice",
                  title: "Pick another name",
                  "aria-label": "Pick another name",
                  onClick: guard("pick another name", function () {
                    changeName(anotherName(name));
                  }),
                },
                diceIcon()
              )
            ),
            e(
              "p",
              { className: "pair-qr-hint", id: NAME_HINT_ID },
              "Fills ",
              e("code", null, NAME_PLACEHOLDER),
              ", the name PlugVR lists the server under. It starts as a random warehouse word; the dice picks another. Left empty, the code uses the one shown in grey."
            ),
            e(
              "label",
              { className: "pair-qr-label", htmlFor: TEXT_ID },
              "Text in the QR code"
            ),
            e("textarea", {
              id: TEXT_ID,
              ref: textArea,
              className: "form-control pair-qr-text",
              value: text,
              rows: 4,
              spellCheck: false,
              autoComplete: "off",
              autoCapitalize: "off",
              autoCorrect: "off",
              "aria-describedby": HINT_ID,
              onChange: guard("change the text", function (event) {
                changeText(event.target.value);
              }),
            }),
            e(
              "p",
              { className: "pair-qr-hint", id: HINT_ID },
              e("code", null, URL_PLACEHOLDER),
              " and ",
              e("code", null, API_KEY_PLACEHOLDER),
              " become this server's URL and API key."
            ),
            PRESETS.map(function (item) {
              return e(
                "button",
                {
                  key: item.name,
                  type: "button",
                  className: "btn btn-secondary btn-sm pair-qr-preset",
                  onClick: guard("reset the text", function () {
                    changeText(item.text);
                  }),
                },
                e("img", { className: "pair-qr-icon", src: item.icon, alt: "" }),
                "Reset to " + item.name
              );
            })
          )
        : null;

      return e(
        "div",
        { className: "pair-qr-panel" },
        loopback ? loopbackWarning(loopback) : null,
        qr.keyless ? keylessNotice() : null,
        qrFrame(qr, preset),
        e(
          "div",
          { className: "pair-qr-bar" },
          e(
            "span",
            { className: "pair-qr-caption", title: captionText },
            preset
              ? e("img", { className: "pair-qr-icon", src: preset.icon, alt: "" })
              : null,
            e("span", { className: "pair-qr-caption-text" }, captionText)
          ),
          e(
            "button",
            {
              type: "button",
              className: "btn btn-secondary btn-sm",
              "aria-expanded": editing,
              "aria-controls": EDITOR_ID,
              onClick: guard("open the editor", function () {
                setEditing(!editing);
              }),
            },
            editing ? "Done" : "Edit"
          )
        ),
        editor
      );
    }

    function PlainDialog(props) {
      return e(
        "div",
        { className: "pair-qr-fallback", role: "dialog", "aria-label": "Pair QR" },
        e(PairQrPanel),
        e(
          "button",
          {
            type: "button",
            className: "btn btn-secondary",
            onClick: guard("close", function () {
              if (typeof props.onHide === "function") {
                props.onHide();
              }
            }),
          },
          "Close"
        )
      );
    }

    function PairQrModal(props) {
      const Modal = bootstrap("Modal");
      const Header = Modal && pluginComponent(Modal, "Header");
      const Title = Modal && pluginComponent(Modal, "Title");
      const Body = Modal && pluginComponent(Modal, "Body");
      if (!Modal || !Header || !Title || !Body) {
        return e(PlainDialog, { onHide: props.onHide });
      }

      return e(
        Modal,
        {
          show: props.show,
          onHide: props.onHide,
          dialogClassName: "pair-qr-modal",
        },
        e(Header, { closeButton: true }, e(Title, null, "Pair QR")),
        e(Body, { className: "pair-qr-body" }, e(PairQrPanel))
      );
    }

    function PairQrRow() {
      const [open, setOpen] = React.useState(false);
      const Setting = pluginComponent(PluginApi.components, "Setting");
      const Button = bootstrap("Button");

      function show() {
        try {
          setOpen(true);
        } catch (err) {
          console.error("Pair QR could not open.", err);
        }
      }

      function hide() {
        try {
          setOpen(false);
        } catch (err) {
          console.error("Pair QR could not close.", err);
        }
      }

      const button = isComponent(Button)
        ? e(
            Button,
            {
              type: "button",
              onClick: show,
            },
            "Show QR code"
          )
        : e(
            "button",
            { type: "button", className: "btn btn-primary", onClick: show },
            "Show QR code"
          );
      const modal = open
        ? e(PluginBoundary, { label: "Pair QR dialog" }, e(PairQrModal, {
            show: true,
            onHide: hide,
          }))
        : null;
      const heading = "Pair QR";
      const description =
        "Generates a QR code for pairing with the URL and API key. The text in the code can be edited.";

      if (!Setting) {
        return e(
          React.Fragment,
          null,
          e(
            "div",
            { className: "setting", id: "pair-qr" },
            e(
              "div",
              null,
              e("h3", null, heading),
              e("div", { className: "sub-heading pair-qr-description" }, description)
            ),
            e("div", null, button)
          ),
          modal
        );
      }

      return e(
        React.Fragment,
        null,
        e(
          Setting,
          { id: "pair-qr", heading: heading, subHeading: description },
          button
        ),
        modal
      );
    }

    // Stash calls the component as (props, legacyContext) and appends the
    // rendered element. It does not catch exceptions; a throw blanks every
    // NumberSetting, which takes down the settings page.
    PluginApi.patch.after("NumberSetting", function () {
      let result;
      try {
        result = arguments.length ? arguments[arguments.length - 1] : null;
        const props = arguments[0];
        if (!props || props.id !== "maxSessionAge") {
          return result;
        }
        return e(
          React.Fragment,
          null,
          e(PluginBoundary, { label: "Pair QR" }, e(PairQrRow)),
          result
        );
      } catch (err) {
        console.error("Pair QR left the setting unchanged.", err);
        return result;
      }
    });
  }
})();
