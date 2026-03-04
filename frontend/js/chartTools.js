/**
 * Chart Drawing Tools — overlay canvas for technical analysis
 *
 * Provides crosshair, horizontal line, trendline, and Fibonacci retracement
 * drawing tools on top of a Chart.js instance. Drawings are stored in chart
 * data coordinates (timestamp + price) and re-rendered when the chart updates.
 */

/* global utils */

var chartTools = {
  /** @type {HTMLCanvasElement} */
  canvas: null,
  /** @type {CanvasRenderingContext2D} */
  ctx: null,
  /** @type {Chart} */
  chart: null,

  // State
  activeTool: null,        // 'crosshair' | 'hline' | 'trendline' | 'fib' | null
  drawings: [],            // stored drawing objects
  _pendingPoint: null,     // first click for two-point tools
  _mousePos: null,         // current {x, y} in CSS pixels for crosshair
  _bound: false,
  _dpr: 1,                 // cached devicePixelRatio

  // Fibonacci levels (standard)
  FIB_LEVELS: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
  FIB_COLORS: [
    'rgba(239, 68, 68, 0.8)',   // 0%
    'rgba(249, 115, 22, 0.7)',  // 23.6%
    'rgba(234, 179, 8, 0.7)',   // 38.2%
    'rgba(34, 197, 94, 0.8)',   // 50%
    'rgba(59, 130, 246, 0.7)',  // 61.8%
    'rgba(139, 92, 246, 0.7)',  // 78.6%
    'rgba(239, 68, 68, 0.8)'   // 100%
  ],

  /**
   * Initialize the overlay. Call once after DOM is ready.
   */
  init: function() {
    this.canvas = document.getElementById('chart-overlay');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');

    this._bindToolbar();
  },

  /**
   * Switch the overlay to a different canvas element (e.g. page ↔ modal).
   * Binds event listeners to the new canvas and restores active tool state.
   * @param {HTMLCanvasElement} canvasEl
   */
  switchCanvas: function(canvasEl) {
    // Reset pointer-events on old canvas
    if (this.canvas) {
      this.canvas.style.pointerEvents = 'none';
      this.canvas.style.cursor = '';
      this.canvas.style.touchAction = '';
    }

    this.canvas = canvasEl;
    if (!canvasEl) return;
    this.ctx = canvasEl.getContext('2d');

    // Bind events on the new canvas
    var self = this;
    canvasEl.addEventListener('mousemove', function(e) { self._onMouseMove(e); });
    canvasEl.addEventListener('mouseleave', function() { self._onMouseLeave(); });
    canvasEl.addEventListener('click', function(e) { self._onClick(e); });
    canvasEl.addEventListener('touchstart', function(e) { self._onTouchStart(e); }, { passive: false });
    canvasEl.addEventListener('touchmove', function(e) { self._onTouchMove(e); }, { passive: false });
    canvasEl.addEventListener('touchend', function(e) { self._onTouchEnd(e); }, { passive: false });

    // Restore active tool state on new canvas
    if (this.activeTool) {
      canvasEl.style.pointerEvents = 'auto';
      canvasEl.style.cursor = 'crosshair';
      canvasEl.style.touchAction = 'none';
    }
  },

  /**
   * Attach to a Chart.js instance. Call after every chart render.
   * @param {Chart} chartInstance
   */
  attach: function(chartInstance) {
    this.chart = chartInstance;
    this._syncSize();
    this.render();

    if (!this._bound) {
      this._bound = true;
      var self = this;

      // Mouse events
      this.canvas.addEventListener('mousemove', function(e) { self._onMouseMove(e); });
      this.canvas.addEventListener('mouseleave', function() { self._onMouseLeave(); });
      this.canvas.addEventListener('click', function(e) { self._onClick(e); });

      // Touch events for mobile
      this.canvas.addEventListener('touchstart', function(e) { self._onTouchStart(e); }, { passive: false });
      this.canvas.addEventListener('touchmove', function(e) { self._onTouchMove(e); }, { passive: false });
      this.canvas.addEventListener('touchend', function(e) { self._onTouchEnd(e); }, { passive: false });

      // Re-sync on resize
      window.addEventListener('resize', function() {
        if (self.chart) {
          self._syncSize();
          self.render();
        }
      });
    }
  },

  /**
   * Clear all drawings (called on timeframe/metric change).
   */
  clearAll: function() {
    this.drawings = [];
    this._pendingPoint = null;
    this.render();
  },

  /**
   * Remove the last drawing.
   */
  undo: function() {
    if (this._pendingPoint) {
      this._pendingPoint = null;
      this.render();
      return;
    }
    this.drawings.pop();
    this.render();
  },

  /**
   * Set the active tool and update toolbar button states.
   * @param {string|null} tool
   */
  setTool: function(tool) {
    // Toggle off if already active
    if (this.activeTool === tool) {
      this.activeTool = null;
    } else {
      this.activeTool = tool;
    }
    this._pendingPoint = null;

    // Update button states
    document.querySelectorAll('.chart-tool-btn[data-tool]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.tool === chartTools.activeTool);
    });

    // When a drawing tool is active, the overlay captures pointer events.
    // Otherwise, pointer events pass through to Chart.js for tooltips/zoom.
    if (this.canvas) {
      this.canvas.style.pointerEvents = this.activeTool ? 'auto' : 'none';
      this.canvas.style.cursor = this.activeTool ? 'crosshair' : '';
      // Also set touch-action to prevent scrolling when a tool is active
      this.canvas.style.touchAction = this.activeTool ? 'none' : '';
    }

    this.render();
  },

  // ── Internal ─────────────────────────────────────────────

  _bindToolbar: function() {
    var self = this;
    document.querySelectorAll('.chart-tool-btn[data-tool]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var tool = btn.dataset.tool;
        if (tool === 'clear') { self.clearAll(); return; }
        if (tool === 'undo')  { self.undo(); return; }
        self.setTool(tool);
      });
    });
  },

  _syncSize: function() {
    if (!this.canvas || !this.chart) return;
    var parent = this.canvas.parentElement;
    var dpr = window.devicePixelRatio || 1;
    this._dpr = dpr;

    var w = parent.clientWidth;
    var h = parent.clientHeight;

    // Set the canvas buffer size (scaled by DPR for sharp rendering)
    this.canvas.width  = w * dpr;
    this.canvas.height = h * dpr;

    // CSS size stays at container size
    this.canvas.style.width  = w + 'px';
    this.canvas.style.height = h + 'px';

    // Scale the context so drawing commands use CSS pixel coordinates
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  /** Convert page-relative mouse/touch event to canvas-relative CSS pixel coords */
  _canvasCoords: function(e) {
    var rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  },

  /** Convert pixel coords to chart data coords {time, value} */
  _pixelToData: function(px) {
    if (!this.chart) return null;
    var area = this.chart.chartArea;
    if (!area) return null;
    // Clamp to chart area
    var cx = Math.max(area.left, Math.min(area.right, px.x));
    var cy = Math.max(area.top, Math.min(area.bottom, px.y));
    return {
      time:  this.chart.scales.x.getValueForPixel(cx),
      value: this.chart.scales.y.getValueForPixel(cy)
    };
  },

  /** Convert chart data coords to pixel coords */
  _dataToPixel: function(d) {
    if (!this.chart) return null;
    return {
      x: this.chart.scales.x.getPixelForValue(d.time),
      y: this.chart.scales.y.getPixelForValue(d.value)
    };
  },

  _isInChartArea: function(px) {
    if (!this.chart) return false;
    var a = this.chart.chartArea;
    return px.x >= a.left && px.x <= a.right && px.y >= a.top && px.y <= a.bottom;
  },

  // ── Events ───────────────────────────────────────────────

  _onMouseMove: function(e) {
    this._mousePos = this._canvasCoords(e);
    if (this.activeTool) this.render();
  },

  _onMouseLeave: function() {
    this._mousePos = null;
    if (this.activeTool) this.render();
  },

  _onClick: function(e) {
    if (!this.activeTool || !this.chart) return;
    var px = this._canvasCoords(e);
    if (!this._isInChartArea(px)) return;
    var data = this._pixelToData(px);
    if (!data) return;

    this._handleToolClick(data, px);
  },

  // ── Touch events ─────────────────────────────────────────

  _onTouchStart: function(e) {
    if (!this.activeTool) return;
    // Prevent scrolling/zooming when a tool is active
    e.preventDefault();
    if (e.touches.length !== 1) return;
    var touch = e.touches[0];
    this._mousePos = this._canvasCoords(touch);
    this.render();
  },

  _onTouchMove: function(e) {
    if (!this.activeTool) return;
    e.preventDefault();
    if (e.touches.length !== 1) return;
    var touch = e.touches[0];
    this._mousePos = this._canvasCoords(touch);
    if (this.activeTool) this.render();
  },

  _onTouchEnd: function(e) {
    if (!this.activeTool || !this.chart) return;
    e.preventDefault();

    // Use the last known position for the click
    var px = this._mousePos;
    if (!px || !this._isInChartArea(px)) {
      this._mousePos = null;
      this.render();
      return;
    }

    var data = this._pixelToData(px);
    if (!data) return;

    this._handleToolClick(data, px);

    // Clear mouse position after touch ends (no hover on mobile)
    if (this.activeTool !== 'crosshair') {
      // For crosshair, keep position briefly for visual feedback
      var self = this;
      setTimeout(function() {
        self._mousePos = null;
        self.render();
      }, 600);
    } else {
      this._mousePos = null;
      this.render();
    }
  },

  /** Shared click handler for both mouse and touch */
  _handleToolClick: function(data, px) {
    var tool = this.activeTool;

    if (tool === 'crosshair') {
      // Crosshair is live — no clicks needed
      return;
    }

    if (tool === 'hline') {
      this.drawings.push({ type: 'hline', value: data.value });
      this.render();
      return;
    }

    if (tool === 'trendline') {
      if (!this._pendingPoint) {
        this._pendingPoint = data;
      } else {
        this.drawings.push({
          type: 'trendline',
          p1: this._pendingPoint,
          p2: data
        });
        this._pendingPoint = null;
        this.render();
      }
      return;
    }

    if (tool === 'fib') {
      if (!this._pendingPoint) {
        this._pendingPoint = data;
      } else {
        this.drawings.push({
          type: 'fib',
          high: Math.max(this._pendingPoint.value, data.value),
          low:  Math.min(this._pendingPoint.value, data.value),
          timeLeft:  Math.min(this._pendingPoint.time, data.time),
          timeRight: Math.max(this._pendingPoint.time, data.time)
        });
        this._pendingPoint = null;
        this.render();
      }
      return;
    }
  },

  // ── Rendering ──────────────────────────────────────────────

  render: function() {
    if (!this.ctx || !this.chart) return;
    var ctx = this.ctx;
    var dpr = this._dpr;
    // Use CSS pixel dimensions for drawing (context is already scaled by DPR)
    var w = this.canvas.width / dpr;
    var h = this.canvas.height / dpr;
    ctx.clearRect(0, 0, w, h);

    var area = this.chart.chartArea;
    if (!area) return;

    // Save context and clip to chart area for drawings
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
    ctx.clip();

    // Render saved drawings
    for (var i = 0; i < this.drawings.length; i++) {
      this._renderDrawing(ctx, this.drawings[i], area);
    }

    // Render pending first-point marker
    if (this._pendingPoint && this._mousePos) {
      var pp = this._dataToPixel(this._pendingPoint);
      if (pp) {
        // Anchor dot
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(99, 102, 241, 0.9)';
        ctx.fill();

        // Preview line from anchor to cursor
        if (this.activeTool === 'trendline') {
          ctx.beginPath();
          ctx.moveTo(pp.x, pp.y);
          ctx.lineTo(this._mousePos.x, this._mousePos.y);
          ctx.strokeStyle = 'rgba(99, 102, 241, 0.5)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Preview fib zone
        if (this.activeTool === 'fib') {
          var curData = this._pixelToData(this._mousePos);
          if (curData) {
            var hi = Math.max(this._pendingPoint.value, curData.value);
            var lo = Math.min(this._pendingPoint.value, curData.value);
            this._renderFibPreview(ctx, hi, lo, area);
          }
        }
      }
    }

    // Crosshair lines (inside clip)
    if (this.activeTool === 'crosshair' && this._mousePos && this._isInChartArea(this._mousePos)) {
      this._renderCrosshairLines(ctx, this._mousePos, area);
    }

    // Restore (remove clip) before rendering crosshair labels in axis areas
    ctx.restore();

    // Crosshair labels (outside clip — drawn in axis gutter areas)
    if (this.activeTool === 'crosshair' && this._mousePos && this._isInChartArea(this._mousePos)) {
      this._renderCrosshairLabels(ctx, this._mousePos, area);
    }
  },

  _renderDrawing: function(ctx, d, area) {
    if (d.type === 'hline') {
      var y = this.chart.scales.y.getPixelForValue(d.value);
      ctx.beginPath();
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.right, y);
      ctx.strokeStyle = 'rgba(234, 179, 8, 0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Price label
      var label = this._formatValue(d.value);
      ctx.font = '11px Inter, sans-serif';
      ctx.fillStyle = 'rgba(234, 179, 8, 0.9)';
      ctx.textAlign = 'left';
      ctx.fillText(label, area.left + 4, y - 4);
    }

    if (d.type === 'trendline') {
      var p1 = this._dataToPixel(d.p1);
      var p2 = this._dataToPixel(d.p2);
      if (!p1 || !p2) return;

      // Extend line to chart edges
      var dx = p2.x - p1.x;
      var dy = p2.y - p1.y;
      if (Math.abs(dx) < 0.001) dx = 0.001;
      var slope = dy / dx;
      var extLeft = { x: area.left, y: p1.y + slope * (area.left - p1.x) };
      var extRight = { x: area.right, y: p1.y + slope * (area.right - p1.x) };

      ctx.beginPath();
      ctx.moveTo(extLeft.x, extLeft.y);
      ctx.lineTo(extRight.x, extRight.y);
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.8)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Anchor dots
      ctx.fillStyle = 'rgba(99, 102, 241, 0.9)';
      ctx.beginPath();
      ctx.arc(p1.x, p1.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p2.x, p2.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (d.type === 'fib') {
      this._renderFib(ctx, d.high, d.low, area);
    }
  },

  _renderFib: function(ctx, high, low, area) {
    var range = high - low;
    if (range <= 0) return;

    for (var i = 0; i < this.FIB_LEVELS.length; i++) {
      var level = this.FIB_LEVELS[i];
      var price = high - range * level;
      var y = this.chart.scales.y.getPixelForValue(price);
      var color = this.FIB_COLORS[i];

      ctx.beginPath();
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.right, y);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(level === 0 || level === 1 ? [] : [4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label
      var pct = (level * 100).toFixed(1) + '%';
      var val = this._formatValue(price);
      ctx.font = '10px Inter, sans-serif';
      ctx.fillStyle = color;
      ctx.textAlign = 'right';
      ctx.fillText(pct + '  ' + val, area.right - 4, y - 3);

      // Subtle fill between levels
      if (i < this.FIB_LEVELS.length - 1) {
        var nextPrice = high - range * this.FIB_LEVELS[i + 1];
        var nextY = this.chart.scales.y.getPixelForValue(nextPrice);
        ctx.fillStyle = color.replace(/[\d.]+\)$/, '0.04)');
        ctx.fillRect(area.left, y, area.right - area.left, nextY - y);
      }
    }
  },

  _renderFibPreview: function(ctx, high, low, area) {
    var range = high - low;
    if (range <= 0) return;

    for (var i = 0; i < this.FIB_LEVELS.length; i++) {
      var level = this.FIB_LEVELS[i];
      var price = high - range * level;
      var y = this.chart.scales.y.getPixelForValue(price);

      ctx.beginPath();
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.right, y);
      ctx.strokeStyle = this.FIB_COLORS[i].replace(/[\d.]+\)$/, '0.35)');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  },

  /** Render crosshair dashed lines (called inside clip) */
  _renderCrosshairLines: function(ctx, pos, area) {
    // Vertical line
    ctx.beginPath();
    ctx.moveTo(pos.x, area.top);
    ctx.lineTo(pos.x, area.bottom);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();

    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(area.left, pos.y);
    ctx.lineTo(area.right, pos.y);
    ctx.stroke();
    ctx.setLineDash([]);
  },

  /** Render crosshair labels in axis gutters (called outside clip) */
  _renderCrosshairLabels: function(ctx, pos, area) {
    var data = this._pixelToData(pos);
    if (!data) return;

    // Price label on Y axis (right gutter)
    var label = this._formatValue(data.value);
    ctx.font = '11px "JetBrains Mono", monospace';
    var tw = ctx.measureText(label).width;
    var labelX = area.right + 2;
    var labelY = pos.y;
    ctx.fillStyle = 'rgba(99, 102, 241, 0.85)';
    ctx.fillRect(labelX, labelY - 8, tw + 8, 16);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(label, labelX + 4, labelY + 4);

    // Time label on X axis (bottom gutter)
    var timeLabel = new Date(data.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.font = '11px "JetBrains Mono", monospace';
    var ttw = ctx.measureText(timeLabel).width;
    var timeLabelX = pos.x - ttw / 2 - 4;
    ctx.fillStyle = 'rgba(99, 102, 241, 0.85)';
    ctx.fillRect(timeLabelX, area.bottom + 2, ttw + 8, 16);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(timeLabel, pos.x, area.bottom + 14);
  },

  _formatValue: function(v) {
    if (typeof utils !== 'undefined' && utils.formatPrice) {
      return utils.formatPrice(v);
    }
    if (v >= 1) return '$' + v.toFixed(2);
    if (v >= 0.01) return '$' + v.toFixed(4);
    return '$' + v.toPrecision(4);
  }
};
