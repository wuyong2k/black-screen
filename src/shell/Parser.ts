import * as Scanner from "./Scanner";
import * as _ from "lodash";
import {Suggestion, styles} from "../plugins/autocompletion_providers/Common";
import {memoizeAccessor} from "../Decorators";
import {commandDescriptions} from "../plugins/autocompletion_providers/Executable";
import {executablesInPaths, mapObject} from "../utils/Common";
import {loginShell} from "../utils/Shell";
import {PreliminaryAutocompletionContext} from "../Interfaces";
import {PluginManager} from "../PluginManager";
import {Aliases} from "../Aliases";
import {
    environmentVariableSuggestions,
    combine,
    executableFilesSuggestions,
} from "../plugins/autocompletion_providers/Common";

export abstract class ASTNode {
    abstract get fullStart(): number;

    abstract get fullEnd(): number;
}

abstract class LeafNode extends ASTNode {
    constructor(private token: Scanner.Token) {
        super();
    }

    get fullStart(): number {
        return this.token.fullStart;
    }

    get fullEnd(): number {
        return this.fullStart + this.token.raw.length;
    }

    get spaces(): string {
        return this.token.raw.match(/^(\s*)/)[1];
    }

    get raw(): string {
        return this.token.raw;
    }

    get value(): string {
        return this.token.value;
    }

    abstract suggestions(context: PreliminaryAutocompletionContext): Promise<Suggestion[]>;
}

abstract class BranchNode extends ASTNode {
    abstract get children(): ASTNode[];

    constructor(protected childTokens: Scanner.Token[]) {
        super();
    }

    get fullStart(): number {
        return this.children[0].fullStart;
    }

    get fullEnd(): number {
        return _.last(this.children).fullEnd;
    }
}

export class CompleteCommand extends BranchNode {
    @memoizeAccessor
    get children(): ASTNode[] {
        const lastChild = _.last(this.childTokens);
        const endsWithSeparator = lastChild instanceof Scanner.Semicolon;

        if (endsWithSeparator) {
            return [
                new List(this.childTokens.slice(0, -1)),
                new ShellSyntaxNode(lastChild),
            ];
        } else {
            return [
                new List(this.childTokens),
            ];
        }
    }
}

class List extends BranchNode {
    @memoizeAccessor
    get children(): ASTNode[] {
        const separatorOpIndex = _.findLastIndex(this.childTokens, token => token instanceof Scanner.Semicolon);

        if (separatorOpIndex !== -1) {
            return [
                new List(this.childTokens.slice(0, separatorOpIndex)),
                new ShellSyntaxNode(this.childTokens[separatorOpIndex]),
                new AndOr(this.childTokens.slice(separatorOpIndex + 1)),
            ];
        } else {
            return [
                new AndOr(this.childTokens),
            ];
        }
    }
}

class AndOr extends BranchNode {
    @memoizeAccessor
    get children(): ASTNode[] {
        const andOrTokenIndex = _.findLastIndex(this.childTokens, token => token instanceof Scanner.And || token instanceof Scanner.Or);

        if (andOrTokenIndex !== -1) {
            return [
                new AndOr(this.childTokens.slice(0, andOrTokenIndex)),
                new ShellSyntaxNode(this.childTokens[andOrTokenIndex]),
                new Pipeline(this.childTokens.slice(andOrTokenIndex + 1)),
            ];
        } else {
            return [
                new Pipeline(this.childTokens),
            ];
        }
    }
}

class Pipeline extends BranchNode {
    @memoizeAccessor
    get children(): ASTNode[] {
        return [new PipeSequence(this.childTokens)];
    }
}

class PipeSequence extends BranchNode {
    @memoizeAccessor
    get children(): ASTNode[] {
        const pipeIndex = _.findLastIndex(this.childTokens, token => token instanceof Scanner.Pipe);

        if (pipeIndex !== -1) {
            return [
                new PipeSequence(this.childTokens.slice(0, pipeIndex)),
                new ShellSyntaxNode(this.childTokens[pipeIndex]),
                new Command(this.childTokens.slice(pipeIndex + 1)),
            ];
        } else {
            return [
                new Command(this.childTokens),
            ];
        }
    }
}

class Command extends BranchNode {
    @memoizeAccessor
    get children(): ASTNode[] {
        if (this.childTokens.length) {
            const children: ASTNode[] = [this.commandWord];
            if (this.childTokens.length > 1) {
                children.push(this.argumentList);
            }

            return children;
        } else {
            return [new EmptyNode()];
        }
    }

    @memoizeAccessor
    get commandWord(): CommandWord {
        return new CommandWord(this.childTokens[0]);
    }

    @memoizeAccessor
    get argumentList(): ArgumentList | undefined {
        return new ArgumentList(this.childTokens.slice(1), this);
    }

    nthArgument(position: OneBasedIndex): Argument | undefined {
        if (this.argumentList) {
            return this.argumentList.arguments[position - 1];
        }
    }

    hasArgument(value: string, currentArgument: Argument): boolean {
        if (this.argumentList) {
            return this.argumentList.arguments.filter(argument => argument !== currentArgument).map(argument => argument.value).includes(value);
        } else {
            return false;
        }
    }
}

class ShellSyntaxNode extends LeafNode {
    async suggestions(context: PreliminaryAutocompletionContext): Promise<Suggestion[]> {
        return [];
    }
}

class CommandWord extends LeafNode {
    async suggestions(context: PreliminaryAutocompletionContext): Promise<Suggestion[]> {
        if (this.value.length === 0) {
            return [];
        }

        const relativeExecutablesSuggestions = await executableFilesSuggestions(this.value, context.environment.pwd);
        const executables = await executablesInPaths(context.environment.path);

        return [
            ...mapObject(context.aliases.toObject(), (key, value) => new Suggestion().withValue(key).withDescription(value).withStyle(styles.alias).withSpace()),
            ...loginShell.preCommandModifiers.map(modifier => new Suggestion().withValue(modifier).withStyle(styles.func).withSpace()),
            ...executables.map(name => new Suggestion().withValue(name).withDescription(commandDescriptions[name] || "").withStyle(styles.executable).withSpace()),
            ...relativeExecutablesSuggestions,
        ];
    }
}

class ArgumentList extends BranchNode {
    constructor(childTokens: Scanner.Token[], private command: Command) {
        super(childTokens);
    }

    @memoizeAccessor
    get children(): ASTNode[] {
        return this.arguments;
    }

    @memoizeAccessor
    get arguments(): Argument[] {
        return this.childTokens.map((token, index) => new Argument(token, this.command, index + 1));
    }
}

export class Argument extends LeafNode {
    readonly position: number;
    readonly command: Command;

    constructor(token: Scanner.Token, command: Command, position: number) {
        super(token);
        this.command = command;
        this.position = position;
    }

    async suggestions(context: PreliminaryAutocompletionContext): Promise<Suggestion[]> {
        const argument = argumentOfExpandedAST(this, context.aliases);
        const provider = combine([
            environmentVariableSuggestions,
            PluginManager.autocompletionProviderFor(argument.command.commandWord.value),
        ]);

        if (Array.isArray(provider)) {
            return provider;
        } else if (provider instanceof Suggestion) {
            return [provider];
        } else {
            return provider(Object.assign({argument: argument}, context));
        }
    }
}

// FIXME: find a better way to search for the argument in the new tree.
function argumentOfExpandedAST(argument: Argument, aliases: Aliases) {
    const commandWord = argument.command.commandWord;

    if (aliases.has(commandWord.value)) {
        const tree = new CompleteCommand(Scanner.scan(serializeReplacing(argument.command, commandWord, aliases.get(commandWord.value))));
        let argumentInNewTreeCorrespondingToTheOldOne: Argument;

        traverse(tree, current => {
            if (current instanceof Argument && current.value === argument.value) {
                argumentInNewTreeCorrespondingToTheOldOne = current;
            }
        });

        return argumentInNewTreeCorrespondingToTheOldOne;


    } else {
        return argument;
    }
}

export class EmptyNode extends LeafNode {
    constructor() {
        super(new Scanner.Empty());
    }

    // FIXME: a workaround for leafNodeAt to parse, say, `ls |` correctly.
    get fullEnd() {
        return Number.MAX_SAFE_INTEGER;
    }

    async suggestions(context: PreliminaryAutocompletionContext): Promise<Suggestion[]> {
        return [];
    }
}

export function leafNodeAt(position: number, node: ASTNode): LeafNode {
    if (node instanceof LeafNode) {
        return node;
    } else if (node instanceof BranchNode) {
        return leafNodeAt(position, node.children.find(child => child.fullStart <= position && child.fullEnd >= position));
    } else {
        throw "Should never happen";
    }
}

function traverse(node: ASTNode, callback: (node: ASTNode) => void) {
    callback(node);

    if (node instanceof BranchNode) {
        node.children.forEach(child => traverse(child, callback));
    }
}

export function serializeReplacing(tree: ASTNode, focused: LeafNode, replacement: string) {
    let serialized = "";

    traverse(tree, current => {
        if (current instanceof LeafNode) {
            if (current === focused) {
                serialized += focused.spaces + replacement;
            } else {
                serialized += current.raw;
            }
        }
    });

    return serialized;
}
