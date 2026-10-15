// Helpers injected in front of every script sent to After Effects.
// ExtendScript is ES3: no JSON, no let/const, no Array.prototype.forEach.

function __str(s) {
    var out = '"';
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        var ch = s.charAt(i);
        if (ch === '"') out += '\\"';
        else if (ch === "\\") out += "\\\\";
        else if (c === 10) out += "\\n";
        else if (c === 13) out += "\\r";
        else if (c === 9) out += "\\t";
        else if (c < 32 || c > 126) {
            var h = c.toString(16);
            while (h.length < 4) h = "0" + h;
            out += "\\u" + h;
        } else out += ch;
    }
    return out + '"';
}

function __ser(v) {
    var t = typeof v;
    if (v === null || v === undefined) return "null";
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return __str(v);
    if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) a.push(__ser(v[i]));
        return "[" + a.join(",") + "]";
    }
    if (t === "object") {
        var o = [];
        for (var k in v) {
            if (v.hasOwnProperty(k) && typeof v[k] !== "function") {
                o.push(__str(k) + ":" + __ser(v[k]));
            }
        }
        return "{" + o.join(",") + "}";
    }
    return "null";
}

// Find a composition by name or id. Falls back to the active comp when ref is empty.
function __findComp(ref) {
    if (ref === undefined || ref === null || ref === "") {
        var a = app.project.activeItem;
        if (a instanceof CompItem) return a;
        throw new Error("No active composition. Specify 'comp' (name or id).");
    }
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && (it.name === ref || it.id === ref)) return it;
    }
    throw new Error("Composition not found: " + ref);
}

// Find a layer by 1-based index or by name.
function __findLayer(comp, ref) {
    if (typeof ref === "number") {
        if (ref < 1 || ref > comp.numLayers) throw new Error("Layer index out of range: " + ref);
        return comp.layer(ref);
    }
    for (var i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === ref) return comp.layer(i);
    }
    throw new Error("Layer not found: " + ref);
}

function __itemType(it) {
    if (it instanceof CompItem) return "composition";
    if (it instanceof FolderItem) return "folder";
    if (it instanceof FootageItem) return "footage";
    return "unknown";
}

function __layerInfo(l) {
    return {
        index: l.index,
        name: l.name,
        enabled: l.enabled,
        inPoint: l.inPoint,
        outPoint: l.outPoint,
        startTime: l.startTime,
        is3D: l.threeDLayer === true,
        kind: l.matchName
    };
}
