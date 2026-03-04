// Chart Drawing Tools — Trendline & Fibonacci Retracement
// Uses LWCV v5 ISeriesPrimitive plugin API (modal chart only)

// ── Trendline Primitive ────────────────────────────────

class TrendLineRenderer {
  constructor(p1, p2) {
    this._p1 = p1;
    this._p2 = p2;
  }

  draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const p1 = this._p1;
      const p2 = this._p2;
      if (p1.x == null || p1.y == null || p2.x == null || p2.y == null) return;

      ctx.beginPath();
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 2;
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      // Draw small circles at anchor points
      [p1, p2].forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#6366f1';
        ctx.fill();
      });
    });
  }
}

class TrendLinePaneView {
  constructor(source) {
    this._source = source;
    this._p1 = { x: null, y: null };
    this._p2 = { x: null, y: null };
  }

  update() {
    const src = this._source;
    if (!src._series || !src._chart || !src._point1 || !src._point2) return;

    const ts = src._chart.timeScale();
    this._p1.x = ts.timeToCoordinate(src._point1.time);
    this._p1.y = src._series.priceToCoordinate(src._point1.price);
    this._p2.x = ts.timeToCoordinate(src._point2.time);
    this._p2.y = src._series.priceToCoordinate(src._point2.price);
  }

  renderer() {
    return new TrendLineRenderer(this._p1, this._p2);
  }
}

class TrendLinePrimitive {
  constructor(point1, point2) {
    this._point1 = point1;
    this._point2 = point2;
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
    this._paneView = new TrendLinePaneView(this);
  }

  attached({ chart, series, requestUpdate }) {
    this._chart = chart;
    this._series = series;
    this._requestUpdate = requestUpdate;
    requestUpdate();
  }

  detached() {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  updateAllViews() {
    this._paneView.update();
  }

  paneViews() {
    return [this._paneView];
  }
}

// ── Fibonacci Retracement Primitive ────────────────────

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = [
  'rgba(239, 68, 68, 0.8)',   // 0%
  'rgba(245, 158, 11, 0.7)',  // 23.6%
  'rgba(234, 179, 8, 0.7)',   // 38.2%
  'rgba(16, 185, 129, 0.8)',  // 50%
  'rgba(59, 130, 246, 0.7)',  // 61.8%
  'rgba(139, 92, 246, 0.7)',  // 78.6%
  'rgba(239, 68, 68, 0.8)',   // 100%
];

class FibRetracementRenderer {
  constructor(levels) {
    this._levels = levels; // [{ y, label, color }]
  }

  draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const w = mediaSize.width;
      this._levels.forEach(lv => {
        if (lv.y == null) return;

        ctx.beginPath();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = lv.color;
        ctx.lineWidth = 1;
        ctx.moveTo(0, lv.y);
        ctx.lineTo(w, lv.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label
        ctx.font = '10px Inter, sans-serif';
        ctx.fillStyle = lv.color;
        ctx.textAlign = 'left';
        ctx.fillText(lv.label, 6, lv.y - 4);
      });
    });
  }
}

class FibRetracementPaneView {
  constructor(source) {
    this._source = source;
    this._levels = [];
  }

  update() {
    const src = this._source;
    if (!src._series || !src._point1 || !src._point2) {
      this._levels = [];
      return;
    }

    const highPrice = Math.max(src._point1.price, src._point2.price);
    const lowPrice = Math.min(src._point1.price, src._point2.price);
    const range = highPrice - lowPrice;

    this._levels = FIB_LEVELS.map((fib, i) => {
      const price = highPrice - range * fib;
      const y = src._series.priceToCoordinate(price);
      return {
        y,
        label: `${fib.toFixed(3)} (${src._formatPrice ? src._formatPrice(price) : price.toFixed(6)})`,
        color: FIB_COLORS[i],
      };
    });
  }

  renderer() {
    return new FibRetracementRenderer(this._levels);
  }
}

class FibRetracementPrimitive {
  constructor(point1, point2, formatPrice) {
    this._point1 = point1;
    this._point2 = point2;
    this._formatPrice = formatPrice;
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
    this._paneView = new FibRetracementPaneView(this);
  }

  attached({ chart, series, requestUpdate }) {
    this._chart = chart;
    this._series = series;
    this._requestUpdate = requestUpdate;
    requestUpdate();
  }

  detached() {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  updateAllViews() {
    this._paneView.update();
  }

  paneViews() {
    return [this._paneView];
  }
}

// ── Drawing Tool Manager ───────────────────────────────

const ChartDrawTools = {
  _chart: null,
  _series: null,
  _mode: null, // 'trend' | 'fib' | null
  _points: [],
  _drawings: [], // { primitive, type }
  _clickHandler: null,
  _crosshairHandler: null,
  _escHandler: null,
  _cursorPoint: null,
  _previewPrimitive: null,

  init(chart, series) {
    this.destroy();
    this._chart = chart;
    this._series = series;
    this._drawings = [];
    this._points = [];
    this._mode = null;
  },

  setMode(mode) {
    // Toggle off if same mode
    if (this._mode === mode) {
      this._cancelDrawing();
      return;
    }

    this._cancelDrawing();
    this._mode = mode;

    if (!mode) return;

    const self = this;

    // Subscribe to chart clicks for point placement
    this._clickHandler = (param) => {
      if (!param.time || !param.point) return;

      const price = self._series.coordinateToPrice(param.point.y);
      const time = param.time;
      if (price == null || time == null) return;

      self._points.push({ time, price });

      if (self._points.length === 2) {
        self._finishDrawing();
      }
    };
    this._chart.subscribeClick(this._clickHandler);

    // ESC cancels drawing
    this._escHandler = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        self._cancelDrawing();
      }
    };
    document.addEventListener('keydown', this._escHandler, true);

    // Update button states
    this._updateButtons();
  },

  _finishDrawing() {
    const p1 = this._points[0];
    const p2 = this._points[1];

    let primitive;
    if (this._mode === 'trend') {
      primitive = new TrendLinePrimitive(p1, p2);
    } else if (this._mode === 'fib') {
      const fmt = (typeof utils !== 'undefined' && utils.formatPrice) ? utils.formatPrice : null;
      primitive = new FibRetracementPrimitive(p1, p2, fmt);
    }

    if (primitive) {
      this._series.attachPrimitive(primitive);
      this._drawings.push({ primitive, type: this._mode });
    }

    // Exit drawing mode
    this._points = [];
    this._mode = null;
    this._unsubscribeEvents();
    this._updateButtons();
  },

  _cancelDrawing() {
    this._points = [];
    this._mode = null;
    this._unsubscribeEvents();
    this._updateButtons();
  },

  _unsubscribeEvents() {
    if (this._clickHandler && this._chart) {
      try { this._chart.unsubscribeClick(this._clickHandler); } catch (_) {}
      this._clickHandler = null;
    }
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler, true);
      this._escHandler = null;
    }
  },

  _updateButtons() {
    const trendBtn = document.getElementById('chart-tool-trend');
    const fibBtn = document.getElementById('chart-tool-fib');
    if (trendBtn) trendBtn.classList.toggle('active', this._mode === 'trend');
    if (fibBtn) fibBtn.classList.toggle('active', this._mode === 'fib');
  },

  clear() {
    this._cancelDrawing();
    this._drawings.forEach(d => {
      try { this._series.detachPrimitive(d.primitive); } catch (_) {}
    });
    this._drawings = [];
  },

  destroy() {
    this._cancelDrawing();
    if (this._series) {
      this._drawings.forEach(d => {
        try { this._series.detachPrimitive(d.primitive); } catch (_) {}
      });
    }
    this._drawings = [];
    this._chart = null;
    this._series = null;
  }
};
