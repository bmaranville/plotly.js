'use strict';

var d3 = require('@plotly/d3');

var Registry = require('../../registry');
var Lib = require('../../lib');
var Axes = require('../../plots/cartesian/axes');

var readPaths = require('./draw_newshape/helpers').readPaths;
var displayOutlines = require('./display_outlines');

var clearOutlineControllers = require('./handle_outline').clearOutlineControllers;

var Color = require('../color');
var Drawing = require('../drawing');
var arrayEditor = require('../../plot_api/plot_template').arrayEditor;

var dragElement = require('../dragelement');
var setCursor = require('../../lib/setcursor');

var svgTextUtils = require('../../lib/svg_text_utils');

var constants = require('./constants');
var helpers = require('./helpers');
var getPathString = helpers.getPathString;
var FROM_TL = require('../../constants/alignment').FROM_TL;


// Shapes are stored in gd.layout.shapes, an array of objects
// index can point to one item in this array,
//  or non-numeric to simply add a new one
//  or -1 to modify all existing
// opt can be the full options object, or one key (to be set to value)
//  or undefined to simply redraw
// if opt is blank, val can be 'add' or a full options object to add a new
//  annotation at that point in the array, or 'remove' to delete this one

module.exports = {
    draw: draw,
    drawOne: drawOne,
    eraseActiveShape: eraseActiveShape
};

function draw(gd) {
    var fullLayout = gd._fullLayout;

    // Remove previous shapes before drawing new in shapes in fullLayout.shapes
    fullLayout._shapeUpperLayer.selectAll('path').remove();
    fullLayout._shapeLowerLayer.selectAll('path').remove();
    fullLayout._shapeUpperLayer.selectAll('text').remove();
    fullLayout._shapeLowerLayer.selectAll('text').remove();

    for(var k in fullLayout._plots) {
        var shapelayer = fullLayout._plots[k].shapelayer;
        if(shapelayer) {
            shapelayer.selectAll('path').remove();
            shapelayer.selectAll('text').remove();
        }
    }

    for(var i = 0; i < fullLayout.shapes.length; i++) {
        if(fullLayout.shapes[i].visible) {
            drawOne(gd, i);
        }
    }

    // may need to resurrect this if we put text (LaTeX) in shapes
    // return Plots.previousPromises(gd);
}

function shouldSkipEdits(gd) {
    return !!gd._fullLayout._outlining;
}

function couldHaveActiveShape(gd) {
    // for now keep config.editable: true as it was before shape-drawing PR
    return !gd._context.edits.shapePosition;
}

function drawOne(gd, index) {
    // remove the existing shape if there is one.
    // because indices can change, we need to look in all shape layers
    gd._fullLayout._paperdiv
        .selectAll('.shapelayer [data-index="' + index + '"]')
        .remove();

    var o = helpers.makeShapesOptionsAndPlotinfo(gd, index);
    var options = o.options;
    var plotinfo = o.plotinfo;

    // this shape is gone - quit now after deleting it
    // TODO: use d3 idioms instead of deleting and redrawing every time
    if(!options._input || options.visible === false) return;

    if(options.layer !== 'below') {
        drawShape(gd._fullLayout._shapeUpperLayer);
    } else if(options.xref === 'paper' || options.yref === 'paper') {
        drawShape(gd._fullLayout._shapeLowerLayer);
    } else {
        if(plotinfo._hadPlotinfo) {
            var mainPlot = plotinfo.mainplotinfo || plotinfo;
            drawShape(mainPlot.shapelayer);
        } else {
            // Fall back to _shapeLowerLayer in case the requested subplot doesn't exist.
            // This can happen if you reference the shape to an x / y axis combination
            // that doesn't have any data on it (and layer is below)
            drawShape(gd._fullLayout._shapeLowerLayer);
        }
    }

    function drawShape(shapeLayer) {
        var d = getPathString(gd, options);
        var attrs = {
            'data-index': index,
            'fill-rule': options.fillrule,
            d: d
        };

        var opacity = options.opacity;
        var fillColor = options.fillcolor;
        var lineColor = options.line.width ? options.line.color : 'rgba(0,0,0,0)';
        var lineWidth = options.line.width;
        var lineDash = options.line.dash;
        if(!lineWidth && options.editable === true) {
            // ensure invisible border to activate the shape
            lineWidth = 5;
            lineDash = 'solid';
        }

        var isOpen = d[d.length - 1] !== 'Z';

        var isActiveShape = couldHaveActiveShape(gd) &&
            options.editable && gd._fullLayout._activeShapeIndex === index;

        if(isActiveShape) {
            fillColor = isOpen ? 'rgba(0,0,0,0)' :
                gd._fullLayout.activeshape.fillcolor;

            opacity = gd._fullLayout.activeshape.opacity;
        }

        var shapeGroup = shapeLayer.append('g')
            .classed('shape-group', true)
            .attr({ 'data-index': index });

        var path = shapeGroup.append('path')
            .attr(attrs)
            .style('opacity', opacity)
            .call(Color.stroke, lineColor)
            .call(Color.fill, fillColor)
            .call(Drawing.dashLine, lineDash, lineWidth);

        setClipPath(shapeGroup, gd, options);

        // Draw or clear the label
        drawLabel(gd, index, options, shapeGroup);

        var editHelpers;
        if(isActiveShape || gd._context.edits.shapePosition) editHelpers = arrayEditor(gd.layout, 'shapes', options);

        if(isActiveShape) {
            path.style({
                cursor: 'move',
            });

            var dragOptions = {
                element: path.node(),
                plotinfo: plotinfo,
                gd: gd,
                editHelpers: editHelpers,
                hasText: options.label.text,
                isActiveShape: true // i.e. to enable controllers
            };

            var polygons = readPaths(d, gd);
            // display polygons on the screen
            displayOutlines(polygons, path, dragOptions);
        } else {
            if(gd._context.edits.shapePosition) {
                setupDragElement(gd, path, options, index, shapeLayer, editHelpers);
            } else if(options.editable === true) {
                path.style('pointer-events',
                    (isOpen || Color.opacity(fillColor) * opacity <= 0.5) ? 'stroke' : 'all'
                );
            }
        }
        path.node().addEventListener('click', function() { return activateShape(gd, path); });
    }
}

function setClipPath(shapePath, gd, shapeOptions) {
    // note that for layer="below" the clipAxes can be different from the
    // subplot we're drawing this in. This could cause problems if the shape
    // spans two subplots. See https://github.com/plotly/plotly.js/issues/1452
    //
    // if axis is 'paper' or an axis with " domain" appended, then there is no
    // clip axis
    var clipAxes = (shapeOptions.xref + shapeOptions.yref).replace(/paper/g, '').replace(/[xyz][1-9]* *domain/g, '');

    Drawing.setClipUrl(
        shapePath,
        clipAxes ? 'clip' + gd._fullLayout._uid + clipAxes : null,
        gd
    );
}

function setupDragElement(gd, shapePath, shapeOptions, index, shapeLayer, editHelpers) {
    var MINWIDTH = 10;
    var MINHEIGHT = 10;

    var xPixelSized = shapeOptions.xsizemode === 'pixel';
    var yPixelSized = shapeOptions.ysizemode === 'pixel';
    var isLine = shapeOptions.type === 'line';
    var isPath = shapeOptions.type === 'path';

    var modifyItem = editHelpers.modifyItem;

    var x0, y0, x1, y1, xAnchor, yAnchor;
    var n0, s0, w0, e0, optN, optS, optW, optE;
    var pathIn;

    var shapeGroup = d3.select(shapePath.node().parentNode);

    // setup conversion functions
    var xa = Axes.getFromId(gd, shapeOptions.xref);
    var xRefType = Axes.getRefType(shapeOptions.xref);
    var ya = Axes.getFromId(gd, shapeOptions.yref);
    var yRefType = Axes.getRefType(shapeOptions.yref);
    var x2p = helpers.getDataToPixel(gd, xa, false, xRefType);
    var y2p = helpers.getDataToPixel(gd, ya, true, yRefType);
    var p2x = helpers.getPixelToData(gd, xa, false, xRefType);
    var p2y = helpers.getPixelToData(gd, ya, true, yRefType);

    var sensoryElement = obtainSensoryElement();
    var dragOptions = {
        element: sensoryElement.node(),
        gd: gd,
        prepFn: startDrag,
        doneFn: endDrag,
        clickFn: abortDrag
    };
    var dragMode;

    dragElement.init(dragOptions);

    sensoryElement.node().onmousemove = updateDragMode;

    function obtainSensoryElement() {
        return isLine ? createLineDragHandles() : shapePath;
    }

    function createLineDragHandles() {
        var minSensoryWidth = 10;
        var sensoryWidth = Math.max(shapeOptions.line.width, minSensoryWidth);

        // Helper shapes group
        // Note that by setting the `data-index` attr, it is ensured that
        // the helper group is purged in this modules `draw` function
        var g = shapeLayer.append('g')
            .attr('data-index', index)
            .attr('drag-helper', true);

        // Helper path for moving
        g.append('path')
          .attr('d', shapePath.attr('d'))
          .style({
              cursor: 'move',
              'stroke-width': sensoryWidth,
              'stroke-opacity': '0' // ensure not visible
          });

        // Helper circles for resizing
        var circleStyle = {
            'fill-opacity': '0' // ensure not visible
        };
        var circleRadius = Math.max(sensoryWidth / 2, minSensoryWidth);

        g.append('circle')
          .attr({
              'data-line-point': 'start-point',
              cx: xPixelSized ? x2p(shapeOptions.xanchor) + shapeOptions.x0 : x2p(shapeOptions.x0),
              cy: yPixelSized ? y2p(shapeOptions.yanchor) - shapeOptions.y0 : y2p(shapeOptions.y0),
              r: circleRadius
          })
          .style(circleStyle)
          .classed('cursor-grab', true);

        g.append('circle')
          .attr({
              'data-line-point': 'end-point',
              cx: xPixelSized ? x2p(shapeOptions.xanchor) + shapeOptions.x1 : x2p(shapeOptions.x1),
              cy: yPixelSized ? y2p(shapeOptions.yanchor) - shapeOptions.y1 : y2p(shapeOptions.y1),
              r: circleRadius
          })
          .style(circleStyle)
          .classed('cursor-grab', true);

        return g;
    }

    function updateDragMode(evt) {
        if(shouldSkipEdits(gd)) {
            dragMode = null;
            return;
        }

        if(isLine) {
            if(evt.target.tagName === 'path') {
                dragMode = 'move';
            } else {
                dragMode = evt.target.attributes['data-line-point'].value === 'start-point' ?
                  'resize-over-start-point' : 'resize-over-end-point';
            }
        } else {
            // element might not be on screen at time of setup,
            // so obtain bounding box here
            var dragBBox = dragOptions.element.getBoundingClientRect();

            // choose 'move' or 'resize'
            // based on initial position of cursor within the drag element
            var w = dragBBox.right - dragBBox.left;
            var h = dragBBox.bottom - dragBBox.top;
            var x = evt.clientX - dragBBox.left;
            var y = evt.clientY - dragBBox.top;
            var cursor = (!isPath && w > MINWIDTH && h > MINHEIGHT && !evt.shiftKey) ?
                dragElement.getCursor(x / w, 1 - y / h) :
                'move';

            setCursor(shapePath, cursor);

            // possible values 'move', 'sw', 'w', 'se', 'e', 'ne', 'n', 'nw' and 'w'
            dragMode = cursor.split('-')[0];
        }
    }

    function startDrag(evt) {
        if(shouldSkipEdits(gd)) return;

        // setup update strings and initial values
        if(xPixelSized) {
            xAnchor = x2p(shapeOptions.xanchor);
        }
        if(yPixelSized) {
            yAnchor = y2p(shapeOptions.yanchor);
        }

        if(shapeOptions.type === 'path') {
            pathIn = shapeOptions.path;
        } else {
            x0 = xPixelSized ? shapeOptions.x0 : x2p(shapeOptions.x0);
            y0 = yPixelSized ? shapeOptions.y0 : y2p(shapeOptions.y0);
            x1 = xPixelSized ? shapeOptions.x1 : x2p(shapeOptions.x1);
            y1 = yPixelSized ? shapeOptions.y1 : y2p(shapeOptions.y1);
        }

        if(x0 < x1) {
            w0 = x0;
            optW = 'x0';
            e0 = x1;
            optE = 'x1';
        } else {
            w0 = x1;
            optW = 'x1';
            e0 = x0;
            optE = 'x0';
        }

        // For fixed size shapes take opposing direction of y-axis into account.
        // Hint: For data sized shapes this is done by the y2p function.
        if((!yPixelSized && y0 < y1) || (yPixelSized && y0 > y1)) {
            n0 = y0;
            optN = 'y0';
            s0 = y1;
            optS = 'y1';
        } else {
            n0 = y1;
            optN = 'y1';
            s0 = y0;
            optS = 'y0';
        }

        // setup dragMode and the corresponding handler
        updateDragMode(evt);
        renderVisualCues(shapeLayer, shapeOptions);
        deactivateClipPathTemporarily(shapePath, shapeOptions, gd);
        dragOptions.moveFn = (dragMode === 'move') ? moveShape : resizeShape;
        dragOptions.altKey = evt.altKey;
    }

    function endDrag() {
        if(shouldSkipEdits(gd)) return;

        setCursor(shapePath);
        removeVisualCues(shapeLayer);

        // Don't rely on clipPath being activated during re-layout
        setClipPath(shapePath, gd, shapeOptions);
        Registry.call('_guiRelayout', gd, editHelpers.getUpdateObj());
    }

    function abortDrag() {
        if(shouldSkipEdits(gd)) return;

        removeVisualCues(shapeLayer);
    }

    function moveShape(dx, dy) {
        if(shapeOptions.type === 'path') {
            var noOp = function(coord) { return coord; };
            var moveX = noOp;
            var moveY = noOp;

            if(xPixelSized) {
                modifyItem('xanchor', shapeOptions.xanchor = p2x(xAnchor + dx));
            } else {
                moveX = function moveX(x) { return p2x(x2p(x) + dx); };
                if(xa && xa.type === 'date') moveX = helpers.encodeDate(moveX);
            }

            if(yPixelSized) {
                modifyItem('yanchor', shapeOptions.yanchor = p2y(yAnchor + dy));
            } else {
                moveY = function moveY(y) { return p2y(y2p(y) + dy); };
                if(ya && ya.type === 'date') moveY = helpers.encodeDate(moveY);
            }

            modifyItem('path', shapeOptions.path = movePath(pathIn, moveX, moveY));
        } else {
            if(xPixelSized) {
                modifyItem('xanchor', shapeOptions.xanchor = p2x(xAnchor + dx));
            } else {
                modifyItem('x0', shapeOptions.x0 = p2x(x0 + dx));
                modifyItem('x1', shapeOptions.x1 = p2x(x1 + dx));
            }

            if(yPixelSized) {
                modifyItem('yanchor', shapeOptions.yanchor = p2y(yAnchor + dy));
            } else {
                modifyItem('y0', shapeOptions.y0 = p2y(y0 + dy));
                modifyItem('y1', shapeOptions.y1 = p2y(y1 + dy));
            }
        }

        shapePath.attr('d', getPathString(gd, shapeOptions));
        renderVisualCues(shapeLayer, shapeOptions);
        drawLabel(gd, index, shapeOptions, shapeGroup);
    }

    function resizeShape(dx, dy) {
        if(isPath) {
            // TODO: implement path resize, don't forget to update dragMode code
            var noOp = function(coord) { return coord; };
            var moveX = noOp;
            var moveY = noOp;

            if(xPixelSized) {
                modifyItem('xanchor', shapeOptions.xanchor = p2x(xAnchor + dx));
            } else {
                moveX = function moveX(x) { return p2x(x2p(x) + dx); };
                if(xa && xa.type === 'date') moveX = helpers.encodeDate(moveX);
            }

            if(yPixelSized) {
                modifyItem('yanchor', shapeOptions.yanchor = p2y(yAnchor + dy));
            } else {
                moveY = function moveY(y) { return p2y(y2p(y) + dy); };
                if(ya && ya.type === 'date') moveY = helpers.encodeDate(moveY);
            }

            modifyItem('path', shapeOptions.path = movePath(pathIn, moveX, moveY));
        } else if(isLine) {
            if(dragMode === 'resize-over-start-point') {
                var newX0 = x0 + dx;
                var newY0 = yPixelSized ? y0 - dy : y0 + dy;
                modifyItem('x0', shapeOptions.x0 = xPixelSized ? newX0 : p2x(newX0));
                modifyItem('y0', shapeOptions.y0 = yPixelSized ? newY0 : p2y(newY0));
            } else if(dragMode === 'resize-over-end-point') {
                var newX1 = x1 + dx;
                var newY1 = yPixelSized ? y1 - dy : y1 + dy;
                modifyItem('x1', shapeOptions.x1 = xPixelSized ? newX1 : p2x(newX1));
                modifyItem('y1', shapeOptions.y1 = yPixelSized ? newY1 : p2y(newY1));
            }
        } else {
            var has = function(str) { return dragMode.indexOf(str) !== -1; };
            var hasN = has('n');
            var hasS = has('s');
            var hasW = has('w');
            var hasE = has('e');

            var newN = hasN ? n0 + dy : n0;
            var newS = hasS ? s0 + dy : s0;
            var newW = hasW ? w0 + dx : w0;
            var newE = hasE ? e0 + dx : e0;

            if(yPixelSized) {
                // Do things in opposing direction for y-axis.
                // Hint: for data-sized shapes the reversal of axis direction is done in p2y.
                if(hasN) newN = n0 - dy;
                if(hasS) newS = s0 - dy;
            }

            // Update shape eventually. Again, be aware of the
            // opposing direction of the y-axis of fixed size shapes.
            if(
                (!yPixelSized && newS - newN > MINHEIGHT) ||
                (yPixelSized && newN - newS > MINHEIGHT)
            ) {
                modifyItem(optN, shapeOptions[optN] = yPixelSized ? newN : p2y(newN));
                modifyItem(optS, shapeOptions[optS] = yPixelSized ? newS : p2y(newS));
            }
            if(newE - newW > MINWIDTH) {
                modifyItem(optW, shapeOptions[optW] = xPixelSized ? newW : p2x(newW));
                modifyItem(optE, shapeOptions[optE] = xPixelSized ? newE : p2x(newE));
            }
        }

        shapePath.attr('d', getPathString(gd, shapeOptions));
        renderVisualCues(shapeLayer, shapeOptions);
        drawLabel(gd, index, shapeOptions, shapeGroup);
    }

    function renderVisualCues(shapeLayer, shapeOptions) {
        if(xPixelSized || yPixelSized) {
            renderAnchor();
        }

        function renderAnchor() {
            var isNotPath = shapeOptions.type !== 'path';

            // d3 join with dummy data to satisfy d3 data-binding
            var visualCues = shapeLayer.selectAll('.visual-cue').data([0]);

            // Enter
            var strokeWidth = 1;
            visualCues.enter()
              .append('path')
              .attr({
                  fill: '#fff',
                  'fill-rule': 'evenodd',
                  stroke: '#000',
                  'stroke-width': strokeWidth
              })
              .classed('visual-cue', true);

            // Update
            var posX = x2p(
              xPixelSized ?
                shapeOptions.xanchor :
                Lib.midRange(
                  isNotPath ?
                    [shapeOptions.x0, shapeOptions.x1] :
                    helpers.extractPathCoords(shapeOptions.path, constants.paramIsX))
            );
            var posY = y2p(
              yPixelSized ?
                shapeOptions.yanchor :
                Lib.midRange(
                  isNotPath ?
                    [shapeOptions.y0, shapeOptions.y1] :
                    helpers.extractPathCoords(shapeOptions.path, constants.paramIsY))
            );

            posX = helpers.roundPositionForSharpStrokeRendering(posX, strokeWidth);
            posY = helpers.roundPositionForSharpStrokeRendering(posY, strokeWidth);

            if(xPixelSized && yPixelSized) {
                var crossPath = 'M' + (posX - 1 - strokeWidth) + ',' + (posY - 1 - strokeWidth) +
                  'h-8v2h8 v8h2v-8 h8v-2h-8 v-8h-2 Z';
                visualCues.attr('d', crossPath);
            } else if(xPixelSized) {
                var vBarPath = 'M' + (posX - 1 - strokeWidth) + ',' + (posY - 9 - strokeWidth) +
                  'v18 h2 v-18 Z';
                visualCues.attr('d', vBarPath);
            } else {
                var hBarPath = 'M' + (posX - 9 - strokeWidth) + ',' + (posY - 1 - strokeWidth) +
                  'h18 v2 h-18 Z';
                visualCues.attr('d', hBarPath);
            }
        }
    }

    function removeVisualCues(shapeLayer) {
        shapeLayer.selectAll('.visual-cue').remove();
    }

    function deactivateClipPathTemporarily(shapePath, shapeOptions, gd) {
        var xref = shapeOptions.xref;
        var yref = shapeOptions.yref;
        var xa = Axes.getFromId(gd, xref);
        var ya = Axes.getFromId(gd, yref);

        var clipAxes = '';
        if(xref !== 'paper' && !xa.autorange) clipAxes += xref;
        if(yref !== 'paper' && !ya.autorange) clipAxes += yref;

        Drawing.setClipUrl(
            shapePath,
            clipAxes ? 'clip' + gd._fullLayout._uid + clipAxes : null,
            gd
        );
    }
}

function drawLabel(gd, index, options, shapeGroup) {
    // Remove existing label
    shapeGroup.selectAll('.shape-label').remove();

    // If no label, return
    if(!options.label.text) return;

    var labelGroupAttrs = {
        'data-index': index,
    };
    var text = options.label.text;
    var font = options.label.font;

    var labelTextAttrs = {
        'data-notex': 1
    };

    var labelGroup = shapeGroup.append('g')
        .attr(labelGroupAttrs)
        .classed('shape-label', true);
    var labelText = labelGroup.append('text')
        .attr(labelTextAttrs)
        .classed('shape-label-text', true)
        .text(text);

    // Get x and y bounds of shape
    var shapex0, shapex1, shapey0, shapey1;
    if(options.path) {
        // If shape is defined as a path, get the
        // min and max bounds across all polygons in path
        var d = getPathString(gd, options);
        var polygons = readPaths(d, gd);
        shapex0 = Infinity;
        shapey0 = Infinity;
        shapex1 = -Infinity;
        shapey1 = -Infinity;
        for(var i = 0; i < polygons.length; i++) {
            for(var j = 0; j < polygons[i].length; j++) {
                var p = polygons[i][j];
                for(var k = 1; k < p.length; k += 2) {
                    var _x = p[k];
                    var _y = p[k + 1];

                    shapex0 = Math.min(shapex0, _x);
                    shapex1 = Math.max(shapex1, _x);
                    shapey0 = Math.min(shapey0, _y);
                    shapey1 = Math.max(shapey1, _y);
                }
            }
        }
    } else {
        // Otherwise, we use the x and y bounds defined in the shape options
        // and convert them to pixel coordinates
        // Setup conversion functions
        var xa = Axes.getFromId(gd, options.xref);
        var xRefType = Axes.getRefType(options.xref);
        var ya = Axes.getFromId(gd, options.yref);
        var yRefType = Axes.getRefType(options.yref);
        var x2p = helpers.getDataToPixel(gd, xa, false, xRefType);
        var y2p = helpers.getDataToPixel(gd, ya, true, yRefType);
        shapex0 = x2p(options.x0);
        shapex1 = x2p(options.x1);
        shapey0 = y2p(options.y0);
        shapey1 = y2p(options.y1);
    }

    // Handle `auto` angle
    var textangle = options.label.textangle;
    if(textangle === 'auto') {
        if(options.type === 'line') {
            // Auto angle for line is same angle as line
            textangle = calcTextAngle(shapex0, shapey0, shapex1, shapey1);
        } else {
            // Auto angle for all other shapes is 0
            textangle = 0;
        }
    }

    // Do an initial render so we can get the text bounding box height
    labelText.call(function(s) {
        s.call(Drawing.font, font).attr({});
        svgTextUtils.convertToTspans(s, gd);
        return s;
    });
    var textBB = Drawing.bBox(labelText.node());

    // Calculate correct (x,y) for text
    // We also determine true xanchor since xanchor depends on position when set to 'auto'
    var textPos = calcTextPosition(shapex0, shapey0, shapex1, shapey1, options, textangle, textBB);
    var textx = textPos.textx;
    var texty = textPos.texty;
    var xanchor = textPos.xanchor;

    // Update (x,y) position, xanchor, and angle
    labelText.attr({
        'text-anchor': {
            left: 'start',
            center: 'middle',
            right: 'end'
        }[xanchor],
        y: texty,
        x: textx,
        transform: 'rotate(' + textangle + ',' + textx + ',' + texty + ')'
    }).call(svgTextUtils.positionText, textx, texty);
}

function calcTextAngle(shapex0, shapey0, shapex1, shapey1) {
    var dy, dx;
    dx = Math.abs(shapex1 - shapex0);
    if(shapex1 >= shapex0) {
        dy = shapey0 - shapey1;
    } else {
        dy = shapey1 - shapey0;
    }
    return -180 / Math.PI * Math.atan2(dy, dx);
}

function calcTextPosition(shapex0, shapey0, shapex1, shapey1, shapeOptions, actualTextAngle, textBB) {
    var textPosition = shapeOptions.label.textposition;
    var textAngle = shapeOptions.label.textangle;
    var textPadding = shapeOptions.label.padding;
    var shapeType = shapeOptions.type;
    var textAngleRad = Math.PI / 180 * actualTextAngle;
    var sinA = Math.sin(textAngleRad);
    var cosA = Math.cos(textAngleRad);
    var xanchor = shapeOptions.label.xanchor;
    var yanchor = shapeOptions.label.yanchor;

    var textx, texty, paddingX, paddingY;

    // Text position functions differently for lines vs. other shapes
    if(shapeType === 'line') {
        // Set base position for start vs. center vs. end of line (default is 'center')
        if(textPosition === 'start') {
            textx = shapex0;
            texty = shapey0;
        } else if(textPosition === 'end') {
            textx = shapex1;
            texty = shapey1;
        } else { // Default: center
            textx = (shapex0 + shapex1) / 2;
            texty = (shapey0 + shapey1) / 2;
        }

        // Set xanchor if xanchor is 'auto'
        if(xanchor === 'auto') {
            if(textPosition === 'start') {
                if(textAngle === 'auto') {
                    if(shapex1 > shapex0) xanchor = 'left';
                    else if(shapex1 < shapex0) xanchor = 'right';
                    else xanchor = 'center';
                } else {
                    if(shapex1 > shapex0) xanchor = 'right';
                    else if(shapex1 < shapex0) xanchor = 'left';
                    else xanchor = 'center';
                }
            } else if(textPosition === 'end') {
                if(textAngle === 'auto') {
                    if(shapex1 > shapex0) xanchor = 'right';
                    else if(shapex1 < shapex0) xanchor = 'left';
                    else xanchor = 'center';
                } else {
                    if(shapex1 > shapex0) xanchor = 'left';
                    else if(shapex1 < shapex0) xanchor = 'right';
                    else xanchor = 'center';
                }
            } else {
                xanchor = 'center';
            }
        }

        // Special case for padding when angle is 'auto' for lines
        // Padding should be treated as an orthogonal offset in this case
        // Otherwise, padding is just a simple x and y offset
        var paddingConstantsX = { left: 1, center: 0, right: -1 };
        var paddingConstantsY = { bottom: -1, middle: 0, top: 1 };
        if(textAngle === 'auto') {
            // Set direction to apply padding (based on `yanchor` only)
            var paddingDirection = paddingConstantsY[yanchor];
            paddingX = -textPadding * sinA * paddingDirection;
            paddingY = textPadding * cosA * paddingDirection;
        } else {
            // Set direction to apply padding (based on `xanchor` and `yanchor`)
            var paddingDirectionX = paddingConstantsX[xanchor];
            var paddingDirectionY = paddingConstantsY[yanchor];
            paddingX = textPadding * paddingDirectionX;
            paddingY = textPadding * paddingDirectionY;
        }
        textx = textx + paddingX;
        texty = texty + paddingY;
    } else {
        // Text position for shapes that are not lines
        // calc horizontal position
        // Horizontal needs a little extra padding to look balanced
        paddingX = textPadding + 3;
        if(textPosition.indexOf('right') !== -1) {
            textx = Math.max(shapex0, shapex1) - paddingX;
            if(xanchor === 'auto') xanchor = 'right';
        } else if(textPosition.indexOf('left') !== -1) {
            textx = Math.min(shapex0, shapex1) + paddingX;
            if(xanchor === 'auto') xanchor = 'left';
        } else { // Default: center
            textx = (shapex0 + shapex1) / 2;
            if(xanchor === 'auto') xanchor = 'center';
        }

        // calc vertical position
        if(textPosition.indexOf('top') !== -1) {
            texty = Math.min(shapey0, shapey1);
        } else if(textPosition.indexOf('bottom') !== -1) {
            texty = Math.max(shapey0, shapey1);
        } else {
            texty = (shapey0 + shapey1) / 2;
        }
        // Apply padding
        paddingY = textPadding;
        if(yanchor === 'bottom') {
            texty = texty - paddingY;
        } else if(yanchor === 'top') {
            texty = texty + paddingY;
        }
    }

    // Shift vertical (& horizontal) position according to `yanchor`
    var shiftFraction = FROM_TL[yanchor];
    // Adjust so that text is anchored at top of first line rather than at baseline of first line
    var baselineAdjust = shapeOptions.label.font.size;
    var textHeight = textBB.height;
    var xshift = (textHeight * shiftFraction - baselineAdjust) * sinA;
    var yshift = -(textHeight * shiftFraction - baselineAdjust) * cosA;

    return { textx: textx + xshift, texty: texty + yshift, xanchor: xanchor };
}

function movePath(pathIn, moveX, moveY) {
    return pathIn.replace(constants.segmentRE, function(segment) {
        var paramNumber = 0;
        var segmentType = segment.charAt(0);
        var xParams = constants.paramIsX[segmentType];
        var yParams = constants.paramIsY[segmentType];
        var nParams = constants.numParams[segmentType];

        var paramString = segment.substr(1).replace(constants.paramRE, function(param) {
            if(paramNumber >= nParams) return param;

            if(xParams[paramNumber]) param = moveX(param);
            else if(yParams[paramNumber]) param = moveY(param);

            paramNumber++;

            return param;
        });

        return segmentType + paramString;
    });
}

function activateShape(gd, path) {
    if(!couldHaveActiveShape(gd)) return;

    var element = path.node();
    var id = +element.getAttribute('data-index');
    if(id >= 0) {
        // deactivate if already active
        if(id === gd._fullLayout._activeShapeIndex) {
            deactivateShape(gd);
            return;
        }

        gd._fullLayout._activeShapeIndex = id;
        gd._fullLayout._deactivateShape = deactivateShape;
        draw(gd);
    }
}

function deactivateShape(gd) {
    if(!couldHaveActiveShape(gd)) return;

    var id = gd._fullLayout._activeShapeIndex;
    if(id >= 0) {
        clearOutlineControllers(gd);
        delete gd._fullLayout._activeShapeIndex;
        draw(gd);
    }
}

function eraseActiveShape(gd) {
    if(!couldHaveActiveShape(gd)) return;

    clearOutlineControllers(gd);

    var id = gd._fullLayout._activeShapeIndex;
    var shapes = (gd.layout || {}).shapes || [];
    if(id < shapes.length) {
        var list = [];
        for(var q = 0; q < shapes.length; q++) {
            if(q !== id) {
                list.push(shapes[q]);
            }
        }

        delete gd._fullLayout._activeShapeIndex;

        Registry.call('_guiRelayout', gd, {
            shapes: list
        });
    }
}
