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

// ── Preview Primitive (anchor dot + dashed line to cursor) ──

class DrawPreviewRenderer {
  constructor(anchor, cursor, mode) {
    this._anchor = anchor;
    this._cursor = cursor;
    this._mode = mode;
  }

  draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      const a = this._anchor;
      const c = this._cursor;
      if (a.x == null || a.y == null) return;

      // Anchor dot — pulsing ring + solid center
      ctx.beginPath();
      ctx.arc(a.x, a.y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#6366f1';
      ctx.fill();

      // Dashed line to cursor (if cursor coords available)
      if (c.x != null && c.y != null) {
        ctx.beginPath();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Small crosshair at cursor
        ctx.beginPath();
        ctx.arc(c.x, c.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(99, 102, 241, 0.8)';
        ctx.fill();
      }
    });
  }
}

class DrawPreviewPaneView {
  constructor(source) {
    this._source = source;
    this._anchor = { x: null, y: null };
    this._cursor = { x: null, y: null };
  }

  update() {
    const src = this._source;
    if (!src._series || !src._chart || !src._anchorPoint) return;

    const ts = src._chart.timeScale();
    this._anchor.x = ts.timeToCoordinate(src._anchorPoint.time);
    this._anchor.y = src._series.priceToCoordinate(src._anchorPoint.price);

    // Cursor uses raw pixel coords (from crosshair move), not time/price
    if (src._cursorPixel) {
      this._cursor.x = src._cursorPixel.x;
      this._cursor.y = src._cursorPixel.y;
    } else {
      this._cursor.x = null;
      this._cursor.y = null;
    }
  }

  renderer() {
    return new DrawPreviewRenderer(this._anchor, this._cursor, this._source._drawMode);
  }
}

class DrawPreviewPrimitive {
  constructor(anchorPoint, drawMode) {
    this._anchorPoint = anchorPoint;
    this._drawMode = drawMode;
    this._cursorPixel = null;
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
    this._paneView = new DrawPreviewPaneView(this);
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

  updateCursor(pixel) {
    this._cursorPixel = pixel;
    if (this._requestUpdate) this._requestUpdate();
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
  _previewPrimitive: null,
  _touchHandlers: null,   // { start, move, end } for mobile drawing
  _chartContainer: null,  // DOM element for touch events
  _touchHandled: false,   // prevents duplicate point from LWCV click after touch

  init(chart, series) {
    this.destroy();
    this._chart = chart;
    this._series = series;
    this._drawings = [];
    this._points = [];
    this._mode = null;

    // Find the chart's container element for touch events
    // LWCV v5 exposes chartElement(), fall back to the modal-price-chart div
    let chartEl = null;
    try { chartEl = chart.chartElement(); } catch (_) {}
    this._chartContainer = chartEl || document.getElementById('modal-price-chart');
  },

  _isTouchDevice() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
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

    // Subscribe to chart clicks for point placement (desktop)
    this._clickHandler = (param) => {
      // Skip if touch already handled this interaction
      if (self._touchHandled) { self._touchHandled = false; return; }
      if (!param.time || !param.point) return;

      const price = self._series.coordinateToPrice(param.point.y);
      const time = param.time;
      if (price == null || time == null) return;

      self._points.push({ time, price });

      if (self._points.length === 1) {
        // First point placed — show preview anchor + subscribe to crosshair for live line
        self._attachPreview(self._points[0]);
      } else if (self._points.length === 2) {
        self._finishDrawing();
      }
    };
    this._chart.subscribeClick(this._clickHandler);

    // Mobile touch events — bridge touch to drawing actions
    this._attachTouchHandlers();

    // Disable chart scroll/scale during drawing on mobile
    this._setChartInteraction(false);

    // ESC cancels drawing
    this._escHandler = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        self._cancelDrawing();
      }
    };
    document.addEventListener('keydown', this._escHandler, true);

    // Update button states + show cancel button
    this._updateButtons();
  },

  // Convert touch coordinates to chart-relative pixel coords
  _touchToChartPoint(touch) {
    const container = this._chartContainer;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return {
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top
    };
  },

  _attachTouchHandlers() {
    const container = this._chartContainer;
    if (!container) return;

    const self = this;
    let touchMoved = false;

    const onTouchStart = (e) => {
      if (!self._mode) return;
      touchMoved = false;
      // Prevent scroll/zoom while drawing
      e.preventDefault();
    };

    const onTouchMove = (e) => {
      if (!self._mode) return;
      touchMoved = true;
      e.preventDefault();

      // Update preview line during drag (after first point placed)
      if (self._previewPrimitive && e.touches.length === 1) {
        const pt = self._touchToChartPoint(e.touches[0]);
        if (pt) {
          self._previewPrimitive.updateCursor(pt);
        }
      }
    };

    const onTouchEnd = (e) => {
      if (!self._mode) return;
      e.preventDefault();

      // Use changedTouches for the final position
      const touch = e.changedTouches[0];
      if (!touch) return;

      const pt = self._touchToChartPoint(touch);
      if (!pt) return;

      // If user dragged significantly after first point, use the drag endpoint as second point
      if (self._points.length === 1 && touchMoved) {
        const price = self._series.coordinateToPrice(pt.y);
        const ts = self._chart.timeScale();
        const time = ts.coordinateToTime(pt.x);
        if (price != null && time != null) {
          self._touchHandled = true;
          self._points.push({ time, price });
          self._finishDrawing();
        }
        return;
      }

      // Tap to place point (same as click)
      const price = self._series.coordinateToPrice(pt.y);
      const ts = self._chart.timeScale();
      const time = ts.coordinateToTime(pt.x);
      if (price == null || time == null) return;

      self._touchHandled = true;
      self._points.push({ time, price });

      if (self._points.length === 1) {
        self._attachPreview(self._points[0]);
      } else if (self._points.length === 2) {
        self._finishDrawing();
      }
    };

    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: false });

    this._touchHandlers = { start: onTouchStart, move: onTouchMove, end: onTouchEnd };
  },

  _removeTouchHandlers() {
    const container = this._chartContainer;
    if (!container || !this._touchHandlers) return;
    container.removeEventListener('touchstart', this._touchHandlers.start);
    container.removeEventListener('touchmove', this._touchHandlers.move);
    container.removeEventListener('touchend', this._touchHandlers.end);
    this._touchHandlers = null;
  },

  // Disable/enable chart pan/zoom (prevents conflict with drawing gestures)
  _setChartInteraction(enabled) {
    if (!this._chart) return;
    try {
      this._chart.applyOptions({
        handleScroll: enabled,
        handleScale: enabled,
      });
    } catch (_) {}
    // Toggle CSS class for touch-action: none and crosshair cursor
    const modalContainer = document.getElementById('chart-modal-container');
    if (modalContainer) {
      modalContainer.classList.toggle('drawing-active', !enabled);
    }
  },

  _attachPreview(anchorPoint) {
    this._removePreview();
    this._previewPrimitive = new DrawPreviewPrimitive(anchorPoint, this._mode);
    this._series.attachPrimitive(this._previewPrimitive);

    // Track cursor via crosshair move for live preview line (desktop)
    const self = this;
    this._crosshairHandler = (param) => {
      if (self._previewPrimitive && param.point) {
        self._previewPrimitive.updateCursor({ x: param.point.x, y: param.point.y });
      }
    };
    this._chart.subscribeCrosshairMove(this._crosshairHandler);
  },

  _removePreview() {
    if (this._previewPrimitive && this._series) {
      try { this._series.detachPrimitive(this._previewPrimitive); } catch (_) {}
      this._previewPrimitive = null;
    }
    if (this._crosshairHandler && this._chart) {
      try { this._chart.unsubscribeCrosshairMove(this._crosshairHandler); } catch (_) {}
      this._crosshairHandler = null;
    }
  },

  _finishDrawing() {
    this._removePreview();

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
    this._setChartInteraction(true);
    this._updateButtons();
  },

  _cancelDrawing() {
    this._removePreview();
    this._points = [];
    const wasActive = this._mode !== null;
    this._mode = null;
    this._unsubscribeEvents();
    if (wasActive) this._setChartInteraction(true);
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
    this._removeTouchHandlers();
  },

  _updateButtons() {
    const trendBtn = document.getElementById('chart-tool-trend');
    const fibBtn = document.getElementById('chart-tool-fib');
    if (trendBtn) trendBtn.classList.toggle('active', this._mode === 'trend');
    if (fibBtn) fibBtn.classList.toggle('active', this._mode === 'fib');

    // Show/hide cancel button (mobile helper — no ESC key on mobile)
    const cancelBtn = document.getElementById('chart-tool-cancel');
    if (cancelBtn) {
      cancelBtn.style.display = this._mode ? '' : 'none';
    }
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
    this._chartContainer = null;
  }
};
