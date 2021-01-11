
//const htmlencode = require('htmlencode').htmlEncode;
var htmlencode = require('htmlspecialchars');

const fs = require('fs');
const util = require('util');

const readFile = util.promisify(fs.readFile);
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

const path = require('path');

module.exports = parse;

module.exports.express = express;

module.exports.macros = macros;

module.exports.brackets = brackets;

const cache = {};

//Express wrapper
async function express(filePath, options, callback)
{
	//console.log("File path", filePath);
	callback(null, await parse(filePath, options));
}

class Funky
{
	constructor(model){
		this.model = model;
		this.all = [];
		this.blocks = {};
		this.current = this.all;
		this.parent = null;
		this.parent_args = {};
	}

	async escaped(str){
		if(str == undefined)return;
		if(this.current !== false)this.current.push(htmlencode(str+''));
	}

	async raw(str){
		if(str == undefined)return;
		if(this.current !== false)this.current.push(str); //Here be monsters!
	}

	async render(file2, args){
		if(args)
			args.__proto__ = this.model;
		else
			args = this.model;

		file2 = path.resolve(path.dirname(file), file2)+'.html';

		this.current.push(await parse(file2, args));
	}

	async yield(name, str){

		//If block set, copy it to the current section
		if(this.blocks[name]){
			var b = this.blocks[name];
			for(var i=0; i<b.length; ++i)this.current.push(b[i]);
		}

		//Else if default string given, use that
		else if(typeof(str) == 'string'){
			this.current.push(str);
		}
	}

	async section(name, str){

		//If no parent
		if(!this.parent){

			//If already set, append it to output, and ignore rest of block
			if(this.blocks[name]){

				//console.log(name+' set already');
				this.current = this.all = this.current.concat(this.blocks[name]);
				this.current = false;
			}

			//Else if given a string, append to output
			else if(typeof(str) == 'string'){
				this.current.push(str);
			}
		}

		//If there is a parent
		else{

			//If already set, ignore the block
			if(this.blocks[name]){
				this.current = false;
			}
			//Else if given a string, set block
			else if(typeof(str) == 'string'){
				this.blocks[name] = [str];
			}
			//If not already set, create and start outputting
			else{
				this.current = this.blocks[name] = [];
			}
		}
	}

	async endsection(){

		//If has a parent, then ignore output, otherwise switch to body
		this.current = this.parent?false:this.all;
	}

	async extends(parent, args){

		this.parent = parent;
		this.parent_args = args;
		this.current = false;
	}
}

var macros = {
	if:(args)=>'{% if'+args+'{ %}',
	else:(args)=>'{% }else{ %}',
	elseif:(args)=>'{% }else if'+args+'{ %}',
	endif:(args)=>'{% } %}',
	while:(args)=>'{% while'+args+'{ %}',
	endwhile:(args)=>'{% } %}',
	for:(args)=>'{% for'+args+'{ %}',
	endfor:(args)=>'{% } %}',
	break:(args)=>'{% break; %}',
	continue:(args)=>'{% continue; %}',
	json:(args)=>'{!! JSON.stringify'+args+' !!}',
	switch:(args)=>'{% switch'+args+'{ %}',
	case:(args)=>'{% case '+args+': %}',
	default:(args)=>'{% default: %}',
	endswitch:(args)=>'{% } %}',
	isset:(args)=>'{% if(typeof '+args+' !== "undefined"){ %}',
	endisset:(args)=>'{% } %}',
}

var brackets = {
	'{':(content)=>{return 'f.escaped('+content+');'},
	'!!':(content)=>{return 'f.raw('+content+');'}, //Here be monsters!
	'%':(content)=>{return content},
	'--':(content)=>{return ''}
}

async function parse(file, model)
{
	//Get from cache
	let f = cache[file];

	//If not found
	if(!f){

		//Load file
		let str = await readFile(file, 'utf8');

		//Create funky (so we know the functions that exist)
		var test = new Funky();


		//Add @escaped blocks between all @verbatim/@js/@comment blocks (so that everything is now inside a block)
		str = str.replace(/(?<!@)@(verbatim|js|comment|escaped)(\s.*?[^@])@end\1/gs, function(match){

			return '@endescaped\r\n' + match + '\r\n@escaped';
		});
		str = '@escaped\r\n' + str + '\r\n@endescaped';

		//For each of these blocks in turn
		str = str.replace(/(?<!@)@(verbatim|js|comment|escaped)(\s.*?[^@])@end\1/gs, function(match, tag, block){

			//Handle verbatim/js/comment blocks
			tag = tag.trim();
			if(tag == 'verbatim'){
				return 'f.raw(`'+block+'`);';
			}
			else if(tag == 'js'){
				return block+';';
			}
			else if(tag == 'comment'){
				return '';
			}

			//Make sure that there is no rogue start or end block inside
			var wrong = block.match(/(?<!@)@(verbatim|js|comment|escaped|endverbatim|endjs|endcomment|endescaped)\s/s);
			if(wrong){
				throw("blade-js syntax error: rogue block tag '"+wrong[1])+"'";
			}

			//Try altering, to:

			//Replace @func(args)
			//optional @ symbol, @ symbol, ignore whitespace, followed by characters (greedy), ignore whitespace, everything (non greedy), ignore whitespace, end of line
			block = block.replace(/(@?)@[ \t]*([a-zA-Z0-9_]+)[ \t]*(.*?)[ \t]*$/mg, function(match, at, func, args){


				//If we hit a @parent, then ignore this line, and change output from 'mysection' to 'mysection_after'

				//If prepended by extra @, don't alter
				if(at){
					return match.substr(1);
				}

				//If func is a compile-time macro, replace with expanded macro
				var macro = macros[func];
				if(macro){
					return macro(args);
				}

				//If func is a run-time function, replace with call to function
				if(test[func]){
					args = args || "()";
					return '{% await f.'+func+args+'; %}';				
				}

				//Compile error!
				throw "blade-js syntax error: unknown macro '"+func+"'";
			});

			//Replace all tags {{ }}, {!! !!}, {% %}
			block = block.replace(/(\s*)(@?)\{(\{|%|\!\!|--)([\-]?)\s*(.*?)\s*([\-]?)(\}|%|\!\!|--)\}(\s*)/g, function(match, start_whitespace, at, start_bracket, start_minus, content, end_minus, end_bracket, end_whitespace){

				//If prepended with @, don't alter
				if(at){
					return match.replace('@','');
				}

				//Remove whitespace before/after if '-' used
				if(start_minus)start_whitespace = '';
				if(end_minus)end_whitespace = '';

				//If known bracket, replace with expanded macro
				var f = brackets[start_bracket];
				if(f){
					content = f(content);
					return start_whitespace + "`);" + content + " f.raw(`" + end_whitespace;
				}

				//Compile error
				throw "blade-js syntax error: unknown bracket type '"+start_bracket+"'";
			});

			block = "f.raw(`" + block + "`);";

			return block;
		});
		str = "with(f.model){" + str + "}";

		//console.log("source code");
		//console.log(file);
		//console.log(str);


		//Interpret function and add to cache
		f = cache[file] = new AsyncFunction('f', str);

		if(process.env.NODE_ENV == 'development'){
			delete cache[file];
		};
		
	}

	//If the model isn't already a Funcy
	if(!(model instanceof Funky)){
		model = new Funky(model);
	}

	//Call template renderer
	await f(model);

	//If no parent
	if(!model.parent){

		//Assemble by joining body blocks
		return model.all.join('');
	}

	//If there is a parent
	else{

		//If args given, use them with fallover to those given
		var args = model.parent_args;
		if(model.parent_args){
			model.parent_args.__proto__ = model.model;
			model.model = model.parent_args;
		}

		//Clear body blocks, parent and parent_args
		var parent = model.parent;
		model.all = model.current = [];
		model.parent = null;
		model.parent_args = {};

		parent = path.resolve(path.dirname(file), parent)+'.html';

		//Run parser and return
		return await parse(parent, model);
	}
}