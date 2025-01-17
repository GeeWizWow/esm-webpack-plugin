const ConcatSource = require("webpack-sources").ConcatSource;
// const MultiModule = require("webpack/lib/MultiModule");
// const ExternalModule = require("webpack/lib/ExternalModule");
const Template = require("webpack/lib/Template");
const Compilation = require("webpack/lib/Compilation");
const PLUGIN_NAME = "EsmWebpackPlugin";
const warn = msg => console.warn(`[${PLUGIN_NAME}] ${msg}`);
const IS_JS_FILE = /\.[cm]?js$/i;

const defaultOptions = {
    // Exclude non-js files
    exclude: fileName => !IS_JS_FILE.test(fileName),

    // Skip Nothing
    skipModule: () => false,

    // Treat externals as globals, by default
    moduleExternals: false,

    // Add __esModule property to all externals
    esModuleExternals: true
};


/**
 * Add ESM `export` statements to the bottom of a webpack chunk
 * with the exposed exports.
 */
module.exports = class EsmWebpackPlugin {
    /**
     *
     * @param {Object} [options]
     * @param {Function} [options.exclude]
     *  A callback function to evaluate each output file name and determine if it should be
     *  excluded from being wrapped with ESM exports. By default, all files whose
     *  file extension is not `.js` or `.mjs` will be excluded.
     *  The provided callback will receive two input arguments:
     *  -   `{String} fileName`: the file name being evaluated
     *  -   `{Chunk} chunk`: the webpack `chunk` being worked on.
     * @param {Function} [options.skipModule]
     *  A callback function to evaluate each single module in the bundle and if its list of
     *  exported members should be included.
     * @param {boolean} [options.moduleExternals]
     * A boolean that determines whether to treat webpack externals as ES modules or not.
     * Defaults to false.
     */
    constructor(options) {
        this._options = {
            ...defaultOptions,
            ...options
        };
    }

    apply(compiler) {
        compiler.hooks.compilation.tap(PLUGIN_NAME, compilationTap.bind(this));
    }
};

function exportsForModule(module, libVar, pluginOptions) {
    let exports = "";
    const namedExports = [];
    const moduleName = typeof module.nameForCondition === 'function'
        ? module.nameForCondition()
        : undefined;

    if (moduleName && pluginOptions.skipModule(moduleName, module)) {
        return '';
    }

    // TODO: Find Webpack 5 alternative
    // if (module instanceof MultiModule) {
    //     module.dependencies.forEach(dependency => {
    //         exports += exportsForModule(dependency.module, libVar, pluginOptions);
    //     });
    // } else

    if (module.buildInfo.topLevelDeclarations) {
        module.buildInfo.topLevelDeclarations.forEach(exportName => {
            if (exportName === "default") {
                exports += `export default ${libVar}['${exportName}'];\n`
            } else {
                const scopedExportVarName = `_${libVar}$${exportName}`;
                exports += `const ${scopedExportVarName} = ${libVar}['${exportName}'];\n`;
                namedExports.push(`    ${scopedExportVarName} as ${exportName}`);
            }
        });
    } else {
        exports += `export default ${libVar};\nexport { ${libVar} };\n`
    }
    return `
${
        exports.length > 0 && namedExports.length > 0
            ? `${libVar} === undefined && console.error('esm-webpack-plugin: nothing exported!');`
            : ''
}
${exports}${
        namedExports.length ?
            `\nexport {\n${namedExports.join(",\n")}\n}` :
            ""
    }`;
}

function importsForModule(chunk, pluginOptions) {
    if (pluginOptions.moduleExternals) {
        const externals = chunk.getModules().filter(m => m.constructor.name === 'ExternalModule');
        const importStatements = externals.map(m => {
            const request = typeof m.request === 'object' ? m.request.amd : m.request;
            const identifier = `__WEBPACK_EXTERNAL_MODULE_${Template.toIdentifier(`${m.id}`)}__`;

            return pluginOptions.esModuleExternals
                ? `import * as $${identifier} from '${request}'; var ${identifier} = cloneWithEsModuleProperty($${identifier});`
                : `import * as ${identifier} from '${request}';`
        })

        const result = [importStatements.join("\n")];

        if (pluginOptions.esModuleExternals) {
            // The code here was originally copied from https://github.com/joeldenning/add-esmodule
            result.push(Template.asString([
                "\n",
                "function cloneWithEsModuleProperty(ns) {",
                Template.indent([
                    "const result = Object.create(null);",
                    `Object.defineProperty(result, "__esModule", {`,
                    Template.indent([
                        `value: true,`,
                        `enumerable: false,`,
                        `configurable: true`,
                    ]),
                    "});",
                    `const propertyNames = Object.getOwnPropertyNames(ns);`,
                    `for (let i = 0; i < propertyNames.length; i++) {`,
                    Template.indent([
                        `const propertyName = propertyNames[i];`,
                        `Object.defineProperty(result, propertyName, {`,
                        Template.indent([
                            `get: function () {`,
                            Template.indent([
                                `return ns[propertyName];`
                            ]),
                            `},`,
                            `enumerable: true,`,
                            `configurable: false,`
                        ]),
                        `});`
                    ]),
                    `}`,
                    `if (Object.getOwnPropertySymbols) {`,
                    Template.indent([
                        `const symbols = Object.getOwnPropertySymbols(ns);`,
                        `for (let i = 0; i < symbols.length; i++) {`,
                        Template.indent([
                            `const symbol = symbols[i];`,
                            `Object.defineProperty(result, symbol, {`,
                            Template.indent([
                                `get: function () {`,
                                Template.indent([
                                    `return ns[symbol];`
                                ]),
                                `},`,
                                `enumerable: false,`,
                                `configurable: false,`,
                            ]),
                            `});`,
                        ]),
                        "}",
                    ]),
                    `}`,
                    `Object.preventExtensions(result);`,
                    `Object.seal(result);`,
                    `if (Object.freeze) {`,
                    Template.indent([
                        `Object.freeze(result);`,
                    ]),
                    `}`,
                    `return result;`,
                ]),
                `}`
            ]));
        }

        result.push("\n");

        return result;
    } else {
        // Use default webpack behavior
        return [];
    }
}

function compilationTap(compilation) {
    const libVar = compilation.outputOptions.library.name;
    const exclude = this._options.exclude;

    if (!libVar) {
        warn("output.library is expected to be set!");
    }

    if (
        compilation.outputOptions.library.type &&
        compilation.outputOptions.library.type !== "var" &&
        compilation.outputOptions.library.type !== "assign"
    ) {
        warn(`output.library.type (${compilation.outputOptions.library.type}) expected to be 'var' or 'assign'!`);
    }

    if (this._options.moduleExternals) {
        compilation.hooks.buildModule.tap(PLUGIN_NAME, (module) => {
            if (module.external) {
                // See https://webpack.js.org/configuration/externals/#externalstype
                // We want AMD because it references __WEBPACK_EXTERNAL_MODULE_ instead
                // of the raw external request string.
                module.externalType = 'amd';
            }
        });
    }

    compilation.hooks.processAssets.tapAsync({ name: PLUGIN_NAME, stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE }, (assets, done) => {
        compilation.chunks.forEach(chunk => {

            if (
                chunk.entryModule
                && chunk.entryModule.buildInfo.topLevelDeclarations
            ) {
                chunk.files.forEach(fileName => {
                    if (exclude && exclude(fileName, chunk)) {
                        return;
                    }

                    // Add the exports to the bottom of the file (expecting only one file) and
                    // add that file back to the compilation
                    compilation.assets[fileName] = new ConcatSource(
                        ...importsForModule(chunk, this._options),
                        compilation.assets[fileName],
                        "\n\n",
                        exportsForModule(chunk.entryModule, libVar, this._options)
                    );
                });
            }
        });

        done();
    });
}
