(function () {
  "use strict";

  try {
    load();
  } catch (err) {
    try {
      console.error("Reset resume time failed to load.", err);
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
      typeof PluginApi.patch.before !== "function"
    ) {
      return;
    }

    const React = PluginApi.React;
    const e = React.createElement;

    const SCHEMA_QUERY = `
      query ResetResumeSchema {
        __schema {
          mutationType {
            fields {
              name
            }
          }
        }
      }
    `;

    const SQL_QUERY = `
      mutation ResetResumeQuery($sql: String!) {
        querySQL(sql: $sql) {
          columns
          rows
        }
      }
    `;

    const SQL_EXEC = `
      mutation ResetResumeExec($sql: String!) {
        execSQL(sql: $sql) {
          rows_affected
        }
      }
    `;

    const RESET_SQL = "UPDATE scenes SET resume_time = 0 WHERE resume_time > 0";
    const CONFIRM_QUESTION = "Reset Resume Time?";
    const CONFIRM_EFFECT = "Confirming will reset resume time to 0 for every scene.";
    const CONFIRM_KEPT = "Play Count and Play Duration are kept.";
    const CONFIRM_WARNING = "This cannot be undone.";
    const CONTACT_URL = "https://github.com/plugvr-studio/stash-plugins/issues";

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

    function reportNote() {
      return e(
        "div",
        {
          style: {
            marginTop: "0.65rem",
            padding: "0.5rem 0.75rem",
            border: "1px solid #394b59",
            borderRadius: "0.25rem",
            background: "rgba(255, 255, 255, 0.04)",
            color: "#bfccd6",
            fontSize: "0.8rem",
            fontWeight: 400,
            lineHeight: 1.4,
          },
        },
        "If you think this is a problem with the plugin, please report it to the developer on ",
        e(
          "a",
          {
            href: CONTACT_URL,
            target: "_blank",
            rel: "noopener noreferrer",
            style: { color: "#48aff0", fontWeight: 600, textDecoration: "underline" },
          },
          "GitHub"
        ),
        "."
      );
    }

    function errorWithReport(text) {
      const body = /[.!?]$/.test(text) ? text : text + ".";
      return e(
        "div",
        null,
        e("span", { className: "text-danger" }, body),
        reportNote()
      );
    }

    // Render failures stay inside this boundary, so the tools list keeps rendering.
    class PluginBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
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
            null,
            e(
              "div",
              { className: "alert alert-danger", role: "alert" },
              e(
                "p",
                { style: { margin: 0 } },
                this.props.label + " failed and was disabled so Stash can keep working."
              )
            ),
            reportNote()
          );
        }
        return this.props.children;
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

    async function checkCompatibility() {
      const schema = await stashGraphQL(SCHEMA_QUERY);
      const fields =
        schema &&
        schema.__schema &&
        schema.__schema.mutationType &&
        schema.__schema.mutationType.fields;
      const names = (Array.isArray(fields) ? fields : []).map(function (field) {
        return field && field.name;
      });
      if (names.indexOf("querySQL") < 0 || names.indexOf("execSQL") < 0) {
        throw new Error("Stash no longer provides querySQL and execSQL.");
      }

      const table = await stashGraphQL(SQL_QUERY, {
        sql: "PRAGMA table_info(scenes)",
      });
      const result = table && table.querySQL;
      const nameIndex =
        result && Array.isArray(result.columns) ? result.columns.indexOf("name") : -1;
      if (nameIndex < 0 || !result.rows || !result.rows.length) {
        throw new Error("The scenes table is missing.");
      }
      const columns = result.rows.map(function (row) {
        return row && row[nameIndex];
      });
      if (columns.indexOf("resume_time") < 0) {
        throw new Error("The scenes table has no resume_time column.");
      }

      await stashGraphQL(SQL_QUERY, { sql: "EXPLAIN " + RESET_SQL });
    }

    async function resetAll() {
      const updated = await stashGraphQL(SQL_EXEC, { sql: RESET_SQL });
      const affected = updated && updated.execSQL && updated.execSQL.rows_affected;
      const count = Number(affected);
      if (affected == null || !Number.isFinite(count)) {
        throw new Error("Stash did not report how many scenes changed.");
      }
      return count;
    }

    function sceneCountLabel(count) {
      return count === 1 ? "1 scene" : count + " scenes";
    }

    function isComponent(type) {
      if (typeof type === "function") {
        return true;
      }
      return Boolean(type && typeof type === "object" && type.$$typeof);
    }

    function pluginComponent(owner, name) {
      try {
        const value = owner && owner[name];
        return isComponent(value) ? value : null;
      } catch (err) {
        console.error("Reset resume time could not read " + name + ".", err);
        return null;
      }
    }

    function bootstrap(name) {
      try {
        const libraries = PluginApi.libraries;
        return pluginComponent(libraries && libraries.Bootstrap, name);
      } catch (err) {
        console.error("Reset resume time could not read Bootstrap.", err);
        return null;
      }
    }

    function ResetResumeRow() {
      // checking, ready, working, done, incompatible, failed
      const [state, setState] = React.useState("checking");
      const [message, setMessage] = React.useState("");
      const [confirming, setConfirming] = React.useState(false);

      function show(nextState, nextMessage) {
        try {
          if (nextMessage !== undefined) {
            setMessage(nextMessage);
          }
          setState(nextState);
        } catch (err) {
          console.error("Reset resume time could not update.", err);
        }
      }

      React.useEffect(function () {
        let cancelled = false;
        try {
          checkCompatibility()
            .then(function () {
              if (!cancelled) {
                show("ready");
              }
            })
            .catch(function (err) {
              if (!cancelled) {
                show("incompatible", errorText(err, ""));
              }
            });
        } catch (err) {
          if (!cancelled) {
            show("incompatible", errorText(err, ""));
          }
        }
        return function () {
          cancelled = true;
        };
      }, []);

      function openConfirm() {
        try {
          setConfirming(true);
        } catch (err) {
          console.error("Reset resume time could not ask for confirmation.", err);
        }
      }

      function closeConfirm() {
        try {
          setConfirming(false);
        } catch (err) {
          console.error("Reset resume time could not close confirmation.", err);
        }
      }

      async function onReset() {
        closeConfirm();
        show("working", "");
        try {
          await checkCompatibility();
        } catch (err) {
          show("incompatible", errorText(err, ""));
          return;
        }
        try {
          const count = await resetAll();
          show("done", "Resume Time reset on " + sceneCountLabel(count) + ".");
        } catch (err) {
          show("failed", errorText(err, "Reset failed."));
        }
      }

      function button(className, label, onClick, disabled) {
        return e(
          "button",
          {
            type: "button",
            className: "btn " + className,
            onClick: function (event) {
              if (typeof onClick !== "function") {
                return;
              }
              try {
                const returned = onClick(event);
                if (returned && typeof returned.then === "function") {
                  returned.catch(function (err) {
                    show("failed", errorText(err, "Reset failed."));
                  });
                }
              } catch (err) {
                console.error("Reset resume time action failed.", err);
                show("failed", errorText(err, "Reset failed."));
              }
            },
            disabled: disabled,
          },
          label
        );
      }

      let subHeading;
      let actions;
      if (state === "incompatible") {
        subHeading = errorWithReport(
          "This extension is not compatible with this Stash version, or the Stash instance or database is not responding as expected. Nothing was changed." +
            (message ? " " + message : "")
        );
        actions = button("btn-danger", "Reset", null, true);
      } else {
        if (state === "done") {
          subHeading = e("span", { className: "text-success" }, message);
        } else if (state === "failed") {
          subHeading = errorWithReport("Reset failed. " + message);
        } else {
          subHeading = "Set Resume Time to 0 for every scene.";
        }
        actions = button(
          "btn-danger",
          state === "checking"
            ? "Checking…"
            : state === "working"
              ? "Resetting…"
              : "Reset",
          openConfirm,
          state === "checking" || state === "working" || confirming
        );
      }

      function confirmDialog() {
        const cancelButton = button("btn-secondary", "Cancel", closeConfirm);
        const resetButton = button("btn-danger", "Reset", onReset);
        const message = e("p", { style: { margin: "0 0 0.75rem" } }, CONFIRM_EFFECT);
        const details = e(
          "ul",
          { style: { margin: 0, paddingLeft: "1.25rem" } },
          e("li", null, CONFIRM_KEPT),
          e(
            "li",
            { className: "text-danger", style: { fontWeight: 600, marginTop: "0.35rem" } },
            CONFIRM_WARNING
          )
        );
        const Modal = bootstrap("Modal");
        const Header = Modal && pluginComponent(Modal, "Header");
        const Title = Modal && pluginComponent(Modal, "Title");
        const Body = Modal && pluginComponent(Modal, "Body");
        const Footer = Modal && pluginComponent(Modal, "Footer");
        if (!Modal || !Header || !Title || !Body || !Footer) {
          return e(
            "div",
            { role: "dialog", "aria-label": CONFIRM_QUESTION },
            e("p", { style: { margin: "0 0 0.75rem" } }, CONFIRM_QUESTION),
            message,
            details,
            e(
              "div",
              { className: "d-flex", style: { gap: "0.5rem" } },
              cancelButton,
              resetButton
            )
          );
        }
        return e(
          Modal,
          { show: true, onHide: closeConfirm },
          e(Header, { closeButton: true }, e(Title, null, CONFIRM_QUESTION)),
          e(Body, null, message, details),
          e(Footer, null, cancelButton, resetButton)
        );
      }

      const dialog = confirming ? confirmDialog() : null;

      let Setting = null;
      try {
        Setting =
          PluginApi.components &&
          typeof PluginApi.components.Setting === "function"
            ? PluginApi.components.Setting
            : null;
      } catch (err) {
        console.error("Reset resume time could not read Setting.", err);
        Setting = null;
      }

      if (Setting) {
        return e(
          React.Fragment,
          null,
          e(
            Setting,
            { heading: "Reset resume time", subHeading: subHeading },
            actions
          ),
          dialog
        );
      }
      return e(
        React.Fragment,
        null,
        e(
          "div",
          { className: "setting" },
          e(
            "div",
            null,
            e("h3", null, "Reset resume time"),
            e("div", { className: "sub-heading" }, subHeading)
          ),
          e("div", null, actions)
        ),
        dialog
      );
    }

    function linksTo(children, path) {
      let found = false;
      if (!React.Children || typeof React.Children.forEach !== "function") {
        return false;
      }
      React.Children.forEach(children, function (child) {
        if (found) {
          return;
        }
        try {
          const heading = child && child.props && child.props.heading;
          if (heading && heading.props && heading.props.to === path) {
            found = true;
          }
        } catch (err) {
          console.error("Reset resume time skipped a settings link.", err);
        }
      });
      return found;
    }

    // Stash does not catch patch exceptions. This before hook must return the
    // original arguments when it fails, or the tools section disappears.
    PluginApi.patch.before("SettingsToolsSection", function () {
      const args = Array.prototype.slice.call(arguments);
      try {
        const props = args[0];
        if (!props || !linksTo(props.children, "/sceneFilenameParser")) {
          return args;
        }
        const children = e(
          React.Fragment,
          null,
          props.children,
          e(PluginBoundary, { label: "Reset resume time" }, e(ResetResumeRow))
        );
        args[0] = Object.assign({}, props, { children: children });
        return args;
      } catch (err) {
        console.error("Reset resume time left Settings tools unchanged.", err);
        return args;
      }
    });
  }
})();
