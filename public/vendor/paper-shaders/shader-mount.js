import { vertexShaderSource } from './vertex-shader.js';
const DEFAULT_MAX_PIXEL_COUNT = 1920 * 1080 * 4;
export class ShaderMount {
    parentElement;
    canvasElement;
    gl;
    program = null;
    uniformLocations = {};
    fragmentShader;
    rafId = null;
    lastRenderTime = 0;
    currentFrame = 0;
    speed = 0;
    currentSpeed = 0;
    providedUniforms;
    mipmaps = [];
    hasBeenDisposed = false;
    resolutionChanged = true;
    textures = new Map();
    minPixelRatio;
    maxPixelCount;
    isSafari = isSafari();
    uniformCache = {};
    textureUnitMap = new Map();
    ownerDocument;
    constructor(parentElement, fragmentShader, uniforms, webGlContextAttributes, speed = 0, frame = 0, minPixelRatio = 2, maxPixelCount = DEFAULT_MAX_PIXEL_COUNT, mipmaps = []){
        if (parentElement?.nodeType === 1) {
            this.parentElement = parentElement;
        } else {
            throw new Error('Paper Shaders: parent element must be an HTMLElement');
        }
        this.ownerDocument = parentElement.ownerDocument;
        if (!this.ownerDocument.querySelector('style[data-paper-shader]')) {
            const styleElement = this.ownerDocument.createElement('style');
            styleElement.innerHTML = defaultStyle;
            styleElement.setAttribute('data-paper-shader', '');
            this.ownerDocument.head.prepend(styleElement);
        }
        const canvasElement = this.ownerDocument.createElement('canvas');
        this.canvasElement = canvasElement;
        this.parentElement.prepend(canvasElement);
        this.fragmentShader = fragmentShader;
        this.providedUniforms = uniforms;
        this.mipmaps = mipmaps;
        this.currentFrame = frame;
        this.minPixelRatio = minPixelRatio;
        this.maxPixelCount = maxPixelCount;
        const gl = canvasElement.getContext('webgl2', {
            antialias: false,
            depth: false,
            stencil: false,
            ...webGlContextAttributes
        });
        if (!gl) {
            throw new Error('Paper Shaders: WebGL is not supported in this browser');
        }
        this.gl = gl;
        this.initProgram();
        this.setupPositionAttribute();
        this.setupUniforms();
        this.setUniformValues(this.providedUniforms);
        this.setupResizeObserver();
        visualViewport?.addEventListener('resize', this.handleVisualViewportChange);
        this.setupIntersectionObserver();
        this.setSpeed(speed);
        this.parentElement.setAttribute('data-paper-shader', '');
        this.parentElement.paperShaderMount = this;
        this.ownerDocument.addEventListener('visibilitychange', this.handleDocumentVisibilityChange);
    }
    initProgram = ()=>{
        const program = createProgram(this.gl, vertexShaderSource, this.fragmentShader);
        if (!program) return;
        this.program = program;
        this.gl.useProgram(program);
    };
    setupPositionAttribute = ()=>{
        const positionAttributeLocation = this.gl.getAttribLocation(this.program, 'a_position');
        const positionBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
        const positions = [
            -1,
            -1,
            1,
            -1,
            -1,
            1,
            -1,
            1,
            1,
            -1,
            1,
            1
        ];
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(positions), this.gl.STATIC_DRAW);
        this.gl.enableVertexAttribArray(positionAttributeLocation);
        this.gl.vertexAttribPointer(positionAttributeLocation, 2, this.gl.FLOAT, false, 0, 0);
    };
    setupUniforms = ()=>{
        const uniformLocations = {
            u_time: this.gl.getUniformLocation(this.program, 'u_time'),
            u_pixelRatio: this.gl.getUniformLocation(this.program, 'u_pixelRatio'),
            u_resolution: this.gl.getUniformLocation(this.program, 'u_resolution')
        };
        Object.entries(this.providedUniforms).forEach(([key, value])=>{
            uniformLocations[key] = this.gl.getUniformLocation(this.program, key);
            if (value instanceof HTMLImageElement) {
                const aspectRatioUniformName = `${key}AspectRatio`;
                uniformLocations[aspectRatioUniformName] = this.gl.getUniformLocation(this.program, aspectRatioUniformName);
            }
        });
        this.uniformLocations = uniformLocations;
    };
    renderScale = 1;
    parentWidth = 0;
    parentHeight = 0;
    parentDevicePixelWidth = 0;
    parentDevicePixelHeight = 0;
    devicePixelsSupported = false;
    intersectionObserver = null;
    isInViewport = true;
    resizeObserver = null;
    setupResizeObserver = ()=>{
        this.resizeObserver = new ResizeObserver(([entry])=>{
            if (entry?.borderBoxSize[0]) {
                const physicalPixelSize = entry.devicePixelContentBoxSize?.[0];
                if (physicalPixelSize !== undefined) {
                    this.devicePixelsSupported = true;
                    this.parentDevicePixelWidth = physicalPixelSize.inlineSize;
                    this.parentDevicePixelHeight = physicalPixelSize.blockSize;
                }
                this.parentWidth = entry.borderBoxSize[0].inlineSize;
                this.parentHeight = entry.borderBoxSize[0].blockSize;
            }
            this.handleResize();
        });
        this.resizeObserver.observe(this.canvasElement);
    };
    setupIntersectionObserver = ()=>{
        const view = this.ownerDocument.defaultView;
        if (!view?.IntersectionObserver) return;
        this.intersectionObserver = new view.IntersectionObserver(([entry])=>{
            this.isInViewport = entry?.isIntersecting ?? true;
            this.updateCurrentSpeed();
        });
        this.intersectionObserver.observe(this.parentElement);
    };
    handleVisualViewportChange = ()=>{
        this.resizeObserver?.disconnect();
        this.setupResizeObserver();
    };
    handleResize = ()=>{
        let targetPixelWidth = 0;
        let targetPixelHeight = 0;
        const dpr = Math.max(1, window.devicePixelRatio);
        const pinchZoom = visualViewport?.scale ?? 1;
        if (this.devicePixelsSupported) {
            const scaleToMeetMinPixelRatio = Math.max(1, this.minPixelRatio / dpr);
            targetPixelWidth = this.parentDevicePixelWidth * scaleToMeetMinPixelRatio * pinchZoom;
            targetPixelHeight = this.parentDevicePixelHeight * scaleToMeetMinPixelRatio * pinchZoom;
        } else {
            let targetRenderScale = Math.max(dpr, this.minPixelRatio) * pinchZoom;
            if (this.isSafari) {
                const zoomLevel = bestGuessBrowserZoom(this.ownerDocument);
                targetRenderScale *= Math.max(1, zoomLevel);
            }
            targetPixelWidth = Math.round(this.parentWidth) * targetRenderScale;
            targetPixelHeight = Math.round(this.parentHeight) * targetRenderScale;
        }
        const maxPixelCountHeadroom = Math.sqrt(this.maxPixelCount) / Math.sqrt(targetPixelWidth * targetPixelHeight);
        const scaleToMeetMaxPixelCount = Math.min(1, maxPixelCountHeadroom);
        const newWidth = Math.round(targetPixelWidth * scaleToMeetMaxPixelCount);
        const newHeight = Math.round(targetPixelHeight * scaleToMeetMaxPixelCount);
        const newRenderScale = newWidth / Math.round(this.parentWidth);
        if (this.canvasElement.width !== newWidth || this.canvasElement.height !== newHeight || this.renderScale !== newRenderScale) {
            this.renderScale = newRenderScale;
            this.canvasElement.width = newWidth;
            this.canvasElement.height = newHeight;
            this.resolutionChanged = true;
            this.gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);
            this.render(performance.now());
        }
    };
    render = (currentTime)=>{
        if (this.hasBeenDisposed) return;
        if (this.program === null) {
            console.warn('Tried to render before program or gl was initialized');
            return;
        }
        const dt = currentTime - this.lastRenderTime;
        this.lastRenderTime = currentTime;
        if (this.currentSpeed !== 0) {
            this.currentFrame += dt * this.currentSpeed;
        }
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        this.gl.uniform1f(this.uniformLocations.u_time, this.currentFrame * 0.001);
        if (this.resolutionChanged) {
            this.gl.uniform2f(this.uniformLocations.u_resolution, this.gl.canvas.width, this.gl.canvas.height);
            this.gl.uniform1f(this.uniformLocations.u_pixelRatio, this.renderScale);
            this.resolutionChanged = false;
        }
        this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
        if (this.currentSpeed !== 0) {
            this.requestRender();
        } else {
            this.rafId = null;
        }
    };
    requestRender = ()=>{
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
        }
        this.rafId = requestAnimationFrame(this.render);
    };
    setTextureUniform = (uniformName, image)=>{
        if (!image.complete || image.naturalWidth === 0) {
            throw new Error(`Paper Shaders: image for uniform ${uniformName} must be fully loaded`);
        }
        const { texture, textureUnit } = this.createTexture(uniformName);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, image);
        if (this.mipmaps.includes(uniformName)) {
            this.gl.generateMipmap(this.gl.TEXTURE_2D);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);
        }
        const error = this.gl.getError();
        if (error !== this.gl.NO_ERROR || texture === null) {
            console.error('Paper Shaders: WebGL error when uploading texture:', error);
            return;
        }
        this.textures.set(uniformName, texture);
        const location = this.uniformLocations[uniformName];
        if (location) {
            this.gl.uniform1i(location, textureUnit);
            const aspectRatioUniformName = `${uniformName}AspectRatio`;
            const aspectRatioLocation = this.uniformLocations[aspectRatioUniformName];
            if (aspectRatioLocation) {
                const aspectRatio = image.naturalWidth / image.naturalHeight;
                this.gl.uniform1f(aspectRatioLocation, aspectRatio);
            }
        }
    };
    createTexture = (uniformName)=>{
        const existingTexture = this.textures.get(uniformName);
        if (existingTexture) {
            this.gl.deleteTexture(existingTexture);
        }
        if (!this.textureUnitMap.has(uniformName)) {
            this.textureUnitMap.set(uniformName, this.textureUnitMap.size);
        }
        const textureUnit = this.textureUnitMap.get(uniformName);
        this.gl.activeTexture(this.gl.TEXTURE0 + textureUnit);
        const texture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        return {
            texture,
            textureUnit
        };
    };
    areUniformValuesEqual = (a, b)=>{
        if (a === b) return true;
        if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
            return a.every((val, i)=>this.areUniformValuesEqual(val, b[i]));
        }
        return false;
    };
    setUniformValues = (updatedUniforms)=>{
        Object.entries(updatedUniforms).forEach(([key, value])=>{
            let cacheValue = value;
            if (value instanceof HTMLImageElement) {
                cacheValue = `${value.src.slice(0, 200)}|${value.naturalWidth}x${value.naturalHeight}`;
            }
            if (this.areUniformValuesEqual(this.uniformCache[key], cacheValue)) return;
            this.uniformCache[key] = cacheValue;
            const location = this.uniformLocations[key];
            if (!location) {
                console.warn(`Uniform location for ${key} not found`);
                return;
            }
            if (value instanceof HTMLImageElement) {
                this.setTextureUniform(key, value);
            } else if (Array.isArray(value)) {
                let flatArray = null;
                let valueLength = null;
                if (value[0] !== undefined && Array.isArray(value[0])) {
                    const firstChildLength = value[0].length;
                    if (value.every((arr)=>arr.length === firstChildLength)) {
                        flatArray = value.flat();
                        valueLength = firstChildLength;
                    } else {
                        console.warn(`All child arrays must be the same length for ${key}`);
                        return;
                    }
                } else {
                    flatArray = value;
                    valueLength = flatArray.length;
                }
                switch(valueLength){
                    case 2:
                        this.gl.uniform2fv(location, flatArray);
                        break;
                    case 3:
                        this.gl.uniform3fv(location, flatArray);
                        break;
                    case 4:
                        this.gl.uniform4fv(location, flatArray);
                        break;
                    case 9:
                        this.gl.uniformMatrix3fv(location, false, flatArray);
                        break;
                    case 16:
                        this.gl.uniformMatrix4fv(location, false, flatArray);
                        break;
                    default:
                        console.warn(`Unsupported uniform array length: ${valueLength}`);
                }
            } else if (typeof value === 'number') {
                this.gl.uniform1f(location, value);
            } else if (typeof value === 'boolean') {
                this.gl.uniform1i(location, value ? 1 : 0);
            } else {
                console.warn(`Unsupported uniform type for ${key}: ${typeof value}`);
            }
        });
    };
    getCurrentFrame = ()=>{
        return this.currentFrame;
    };
    setFrame = (newFrame)=>{
        this.currentFrame = newFrame;
        this.lastRenderTime = performance.now();
        this.renderUnlessAnimating();
    };
    setSpeed = (newSpeed = 1)=>{
        this.speed = newSpeed;
        this.updateCurrentSpeed();
    };
    updateCurrentSpeed = ()=>{
        this.setCurrentSpeed(this.ownerDocument.hidden || !this.isInViewport ? 0 : this.speed);
    };
    setCurrentSpeed = (newSpeed)=>{
        this.currentSpeed = newSpeed;
        if (this.rafId === null && newSpeed !== 0) {
            this.lastRenderTime = performance.now();
            this.rafId = requestAnimationFrame(this.render);
        }
        if (this.rafId !== null && newSpeed === 0) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    };
    setMaxPixelCount = (newMaxPixelCount = DEFAULT_MAX_PIXEL_COUNT)=>{
        this.maxPixelCount = newMaxPixelCount;
        this.handleResize();
    };
    setMinPixelRatio = (newMinPixelRatio = 2)=>{
        this.minPixelRatio = newMinPixelRatio;
        this.handleResize();
    };
    setUniforms = (newUniforms)=>{
        this.setUniformValues(newUniforms);
        this.providedUniforms = {
            ...this.providedUniforms,
            ...newUniforms
        };
        this.renderUnlessAnimating();
    };
    renderUnlessAnimating = ()=>{
        if (this.rafId === null) {
            this.render(performance.now());
        }
    };
    handleDocumentVisibilityChange = ()=>{
        this.updateCurrentSpeed();
    };
    dispose = ()=>{
        this.hasBeenDisposed = true;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        if (this.gl && this.program) {
            this.textures.forEach((texture)=>{
                this.gl.deleteTexture(texture);
            });
            this.textures.clear();
            this.gl.deleteProgram(this.program);
            this.program = null;
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
            this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, null);
            this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, null);
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
            this.gl.getError();
        }
        this.gl.getExtension('WEBGL_lose_context')?.loseContext();
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }
        visualViewport?.removeEventListener('resize', this.handleVisualViewportChange);
        this.ownerDocument.removeEventListener('visibilitychange', this.handleDocumentVisibilityChange);
        this.uniformLocations = {};
        this.canvasElement.remove();
        delete this.parentElement.paperShaderMount;
    };
}
function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('An error occurred compiling the shaders: ' + gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}
function createProgram(gl, vertexShaderSource, fragmentShaderSource) {
    const format = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT);
    const precision = format ? format.precision : null;
    if (precision && precision < 23) {
        vertexShaderSource = vertexShaderSource.replace(/precision\s+(lowp|mediump)\s+float;/g, 'precision highp float;');
        fragmentShaderSource = fragmentShaderSource.replace(/precision\s+(lowp|mediump)\s+float/g, 'precision highp float').replace(/\b(uniform|varying|attribute)\s+(lowp|mediump)\s+(\w+)/g, '$1 highp $3');
    }
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!vertexShader || !fragmentShader) return null;
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Unable to initialize the shader program: ' + gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        return null;
    }
    gl.detachShader(program, vertexShader);
    gl.detachShader(program, fragmentShader);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return program;
}
const defaultStyle = `@layer paper-shaders {
  :where([data-paper-shader]) {
    isolation: isolate;
    position: relative;

    & > canvas {
      contain: strict;
      display: block;
      position: absolute;
      inset: 0;
      z-index: -1;
      width: 100%;
      height: 100%;
      border-radius: inherit;
      corner-shape: inherit;
    }
  }
}`;
export function isPaperShaderElement(element) {
    return 'paperShaderMount' in element;
}
function isSafari() {
    const ua = navigator.userAgent.toLowerCase();
    return ua.includes('safari') && !ua.includes('chrome') && !ua.includes('android');
}
function bestGuessBrowserZoom(doc) {
    const viewportScale = visualViewport?.scale ?? 1;
    const viewportWidth = visualViewport?.width ?? window.innerWidth;
    const scrollbarWidth = window.innerWidth - doc.documentElement.clientWidth;
    const innerWidth = viewportScale * viewportWidth + scrollbarWidth;
    const ratio = outerWidth / innerWidth;
    const zoomPercentageRounded = Math.round(100 * ratio);
    if (zoomPercentageRounded % 5 === 0) {
        return zoomPercentageRounded / 100;
    }
    if (zoomPercentageRounded === 33) {
        return 1 / 3;
    }
    if (zoomPercentageRounded === 67) {
        return 2 / 3;
    }
    if (zoomPercentageRounded === 133) {
        return 4 / 3;
    }
    return ratio;
}
