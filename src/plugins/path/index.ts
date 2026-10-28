import { I18nText } from '@logic-arrows/lang/i18n-text';
import { ReactiveValue } from 'src/core/utils/ReactiveValue';
import { LmbLocale, RmbLocale } from '../core/KeybindsLocales';
import { type KeyBindHint, Plugin, PluginPriority } from '../core/Plugin';
import { CorePlugin } from '../graphdlc';
import { PatchGame } from './patches/PatchGame';
import { PatchPlayerControls } from './patches/PatchPlayerControls';

const Patches = [PatchGame, PatchPlayerControls];

const PathfindingLocale = new I18nText(
    'pathfinding',
    'прокладка пути',
    'прокладання шляху',
    'пракладка шляху',
    "recherche d'itinéraire",
);

const LinearPathLocale = new I18nText(
    'linear path',
    'линейный путь',
    'лінійний шлях',
    'лінейны шлях',
    'trajet linéaire',
);

const CancelPathLocale = new I18nText(
    'cancel path',
    'отмена пути',
    'скасування шляху',
    'адмена шляху',
    'annulation du trajet',
);

const FlexRoutingLocale = new I18nText(
    'toggle flex mark mode',
    'включить режим отметок маршрутизации',
    'увімкнути режимозначок маршрутизації',
    'уключыцьрэжым пазнак маршрутызацыі',
    'activer le mode de marquage flex',
);

const FlexMarkLocale = new I18nText(
    'mark or unmark an input',
    'отметить или снять отметку входа',
    'позначити або зняти позначку входу',
    'пазначыць або зняць пазнаку ўваходу',
    'marquer ou démarquer une entrée',
);

const FlexSelectAllLocale = new I18nText(
    'select all marked inputs',
    'выделить все отмеченные входы',
    'виділити всі позначені входи',
    'вылучыць усе пазначаныя ўваходы',
    'sélectionner toutes les entrées marquées',
);

const FlexRouteLocale = new I18nText(
    'Ctrl-drag a selected mark, release, then press Space to save the route preview',
    'Ctrl-перетаскивание отметки, отпускание и Space для сохранения предпросмотра',
    'Ctrl-перетягування позначки, відпускання та Space для збереження попереднього перегляду',
    'Ctrl-перацягванне пазнакі, адпусканне і Space для захавання папярэдняга прагляду',
    'Ctrl-glissez une marque, relâchez, puis Espace pour enregistrer le trajet en aperçu',
);

const FlexSavePreviewLocale = new I18nText(
    'Space confirms the released drag into preview and clears marks',
    'Space сохраняет перетаскивание в предпросмотр и снимает отметки',
    'Space зберігає перетягування в попередній перегляд і знімає позначки',
    'Space захоўвае перацягванне ў папярэдні прагляд і здымае пазнакі',
    'Espace enregistre le trajet dans l’aperçu et efface les marques',
);

const FlexCommitLocale = new I18nText(
    'Enter commits all staged routes',
    'Enter применяет все предварительно проложенные маршруты',
    'Enter застосовує всі попередньо прокладені маршрути',
    'Enter ужывае ўсе папярэдне пракладзеныя маршруты',
    'Entrée applique tous les trajets prévisualisés',
);

const FlexTransformLocale = new I18nText(
    'W/A/S/D set rotation (W=0°, D=90°, S=180°, A=270°); F flips the selection',
    'W/A/S/D задают поворот (W=0°, D=90°, S=180°, A=270°); F отражает выделение',
    'W/A/S/D задають поворот (W=0°, D=90°, S=180°, A=270°); F віддзеркалює виділення',
    'W/A/S/D задаюць паварот (W=0°, D=90°, S=180°, A=270°); F адлюстроўвае вылучэнне',
    'W/A/S/D définissent la rotation (W=0°, D=90°, S=180°, A=270°) ; F retourne la sélection',
);

const FlexCancelLocale = new I18nText(
    'Escape cancels a drag, then exits mark mode',
    'Escape отменяет перетаскивание, затем выходит из режима',
    'Escape скасовує перетягування, потім виходить із режиму',
    'Escape адмяняе перацягванне, потым выходзіць з рэжыму',
    'Échap annule le glisser, puis quitte le mode',
);

export const PathBuildingTrigger = new ReactiveValue(false);
export const FlexRoutingTrigger = new ReactiveValue(false);

const KeyBindHints: KeyBindHint[] = [
    {
        keys: [RmbLocale],
        showOn: ['free'],
        description: PathfindingLocale,
    },
    {
        keys: [RmbLocale],
        showOn: ['arrow'],
        description: LinearPathLocale,
    },
    {
        keys: [LmbLocale],
        showOn: ['free', 'arrow'],
        triggers: [PathBuildingTrigger],
        description: CancelPathLocale,
    },
    {
        keys: ['B'],
        showOn: ['free', 'arrow', 'selected'],
        description: FlexRoutingLocale,
    },
    {
        keys: [LmbLocale],
        showOn: ['free', 'arrow', 'selected'],
        triggers: [FlexRoutingTrigger],
        description: FlexMarkLocale,
    },
    {
        keys: ['T'],
        showOn: ['free', 'arrow', 'selected'],
        triggers: [FlexRoutingTrigger],
        description: FlexSelectAllLocale,
    },
    {
        keys: ['Ctrl', LmbLocale],
        showOn: ['free', 'arrow', 'selected'],
        triggers: [FlexRoutingTrigger],
        description: FlexRouteLocale,
    },
    {
        keys: ['W', 'A', 'S', 'D', 'F'],
        showOn: ['free', 'arrow', 'selected'],
        triggers: [FlexRoutingTrigger],
        description: FlexTransformLocale,
    },
    {
        keys: ['Space'],
        showOn: ['free', 'arrow', 'selected'],
        triggers: [FlexRoutingTrigger],
        description: FlexSavePreviewLocale,
    },
    {
        keys: ['Enter'],
        showOn: ['free', 'arrow', 'selected'],
        triggers: [FlexRoutingTrigger],
        description: FlexCommitLocale,
    },
    {
        keys: ['Esc'],
        showOn: ['free', 'arrow', 'selected'],
        triggers: [FlexRoutingTrigger],
        description: FlexCancelLocale,
    },
];

export const PathPlugin = new Plugin(
    'graphdlc-path',
    {
        name: 'GraphDLC Path',
        priority: PluginPriority.MEDIUM,
        dependencies: [CorePlugin],
        defaultEnabled: true,
    },
    {
        patches: Patches,
        keyBindHints: KeyBindHints,
    },
);
