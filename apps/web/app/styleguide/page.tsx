'use client';

import { useState } from 'react';
import { ChevronDown, Plus, Sparkles, Wand2, Trash2, Copy, GitBranch } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectGroup,
} from '@/components/ui/select';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
// ---- P1: the 13 ported primitives (neobrutalism.dev → Slate Brutal via alias) ----
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from '@/components/ui/table';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from '@/components/ui/command';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { Info, TriangleAlert, Bell, Film, Image as ImageIcon, Wand } from '@/components/ui/icons';

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="py-7">
      <p className="eyebrow-mono mb-4">{label}</p>
      {children}
    </section>
  );
}

const SWATCHES: [string, string, string][] = [
  ['--bg', '#111317', 'graphite canvas'],
  ['--surface', '#1B1E24', 'lifted surface'],
  ['--surface-2', '#15171C', 'inset / well'],
  ['--ink', '#ECEEF3', 'bone · text + border'],
  ['--acc', '#8D76F6', 'periwinkle · CTA'],
  ['--acc-2', '#77D799', 'mint · success'],
  ['--danger', '#FF5247', 'coral · destructive'],
];

export default function Styleguide() {
  const [grade, setGrade] = useState([62]);
  const [hd, setHd] = useState(true);
  const [model, setModel] = useState('seedance-2');

  return (
    <TooltipProvider delayDuration={200}>
      <main className="mx-auto max-w-5xl px-6 py-16">
        {/* ---- header ---- */}
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="font-display text-2xl font-black tracking-tight"
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-primary-foreground)',
              border: '2.5px solid var(--color-line)',
              boxShadow: '3px 3px 0 0 var(--color-shadow)',
              padding: '2px 12px',
            }}
          >
            SEED
          </span>
          <span className="badge-new px-2 py-0.5 text-[10px]">NEW</span>
        </div>
        <p className="eyebrow-mono mt-6">Система · Component library · Slate Brutal</p>
        <h1 className="text-h1 mt-2">
          ТЁМНЫЙ
          <br />
          НЕО-БРУТАЛИЗМ
        </h1>
        <p
          className="text-body-lg mt-4 max-w-xl"
          style={{ color: 'var(--color-muted-foreground)' }}
        >
          Графитовый холст, костяные границы (жёсткие 2.5px), барвинковые офсет-тени без размытия,
          тактильное нажатие. Unbounded (дисплей) + Onest (UI/текст) + Martian Mono (ярлыки).
          Никакого стекла, размытия и градиентов.
        </p>

        <hr className="rule mt-10" />

        {/* ---- palette ---- */}
        <Section label="Палитра · the Slate tokens">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {SWATCHES.map(([token, hex, note]) => (
              <div key={token} className="glass overflow-hidden p-0">
                <div className="h-16 w-full" style={{ background: hex }} />
                <div className="px-2 py-2" style={{ borderTop: '2.5px solid var(--color-line)' }}>
                  <div className="font-mono text-[11px] font-bold uppercase tracking-wider">
                    {token}
                  </div>
                  <div
                    className="font-mono text-[10px]"
                    style={{ color: 'var(--color-muted-foreground)' }}
                  >
                    {hex} · {note}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Separator />

        {/* ---- type ---- */}
        <Section label="Типографика · Unbounded + Onest + Martian Mono">
          <div className="grid gap-3">
            <h2 className="text-h1">Создать видео — H1</h2>
            <h3 className="text-h2">Заголовок второго уровня — H2</h3>
            <h3 className="text-h3">Заголовок третьего уровня — H3</h3>
            <p
              className="font-display text-[13px] tracking-wide"
              style={{ color: 'var(--color-muted-foreground)' }}
            >
              ↑ Unbounded · дисплей · Cyrillic + Latin: Аа Бб Ёё Її Ґґ Єє / Aa Gg Qq
            </p>
            <p className="text-body-lg">
              Основной текст · body-lg · Onest 500 · читаемая гуманистическая антиква.
            </p>
            <p className="text-body-md" style={{ color: 'var(--color-muted-foreground)' }}>
              Вторичный текст · body-md · Onest · приглушённый костяной (AA): Аа Бб Вв Ёё Ыы Ъъ Ьь.
            </p>
            <p className="text-label" style={{ color: 'var(--color-muted-foreground)' }}>
              МОНО-ЯРЛЫК · MARTIAN MONO · 180 ТОКЕНОВ/СЕК · v0.42 · ID 0xA1F3
            </p>
          </div>
        </Section>

        <Separator />

        {/* ---- buttons ---- */}
        <Section label="Кнопки · варианты + тактильное нажатие">
          <div className="flex flex-wrap items-center gap-3">
            <Button>
              <Sparkles /> Создать
            </Button>
            <Button variant="secondary">
              <Plus /> Снять всё
            </Button>
            <Button variant="outline">Режиссёр</Button>
            <Button variant="ghost">Отмена</Button>
            <Button variant="destructive">
              <Trash2 /> Удалить
            </Button>
            <Button variant="link">Подробнее</Button>
            <Button disabled>Недоступно</Button>
            <Button size="sm" variant="secondary">
              small
            </Button>
            <Button size="icon" variant="outline" aria-label="add">
              <Plus />
            </Button>
          </div>
        </Section>

        <Separator />

        {/* ---- badges + chips + stickers ---- */}
        <Section label="Бейджи · чипы · стикеры">
          <div className="flex flex-wrap items-center gap-3">
            <Badge>default</Badge>
            <Badge variant="accent">accent</Badge>
            <Badge variant="mint">success</Badge>
            <Badge variant="outline">outline</Badge>
            <Badge variant="destructive">error</Badge>
            <span className="sticker-rec inline-block px-2 py-1 text-[10px]">РЕКОМЕНДУЕМ</span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <button
              className="chip px-3 py-2 text-[12px] font-bold tracking-wide"
              data-selected="true"
            >
              ДЛИНА · 5С
            </button>
            <button className="chip px-3 py-2 text-[12px] font-bold tracking-wide">
              ФОРМАТ · 16:9
            </button>
            <button className="chip px-3 py-2 text-[12px] font-bold tracking-wide">
              КАЧЕСТВО · 720P
            </button>
            <button className="chip px-3 py-2 text-[12px] font-bold tracking-wide">ДОП.</button>
          </div>
        </Section>

        <Separator />

        {/* ---- floating chrome ---- */}
        <Section label="Плавающие панели · сплошные блоки (без размытия)">
          <div className="flex flex-wrap items-center gap-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary">
                  Действия <ChevronDown className="opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Ветка кадра</DropdownMenuLabel>
                <DropdownMenuItem>
                  <Wand2 /> Смешать
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Copy /> Заменить
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <GitBranch /> Повторить ветку
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive>
                  <Trash2 /> Удалить
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="w-56" aria-label="Модель">
                <SelectValue placeholder="Модель" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Видео</SelectLabel>
                  <SelectItem value="seedance-2">Seedance 2.0</SelectItem>
                  <SelectItem value="seedance-2-fast">Seedance 2.0 Fast</SelectItem>
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel>Изображение</SelectLabel>
                  <SelectItem value="seedream-4">Seedream 4.0</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>

            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Открыть диалог</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Снять всю сцену?</DialogTitle>
                  <DialogDescription>
                    3 кадра уйдут в очередь. Примерно 720 токенов.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="ghost">Отмена</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button>Снять всё</Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="hint">
                  <Sparkles />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Улучшить промпт</TooltipContent>
            </Tooltip>
          </div>
        </Section>

        <Separator />

        {/* ---- cards + tile ---- */}
        <Section label="Карточки · офсет-тень + плитка с уголками">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            {[
              ['Персонаж', 'Continuity across the sequence'],
              ['Локация', 'Held lighting + look'],
              ['Кадр', 'Shot grammar baked in'],
            ].map(([t, d], i) => (
              <Card key={t} className="glass-hover cursor-pointer">
                <CardHeader>
                  <Badge variant="accent" className="w-fit">
                    0{i + 1} · shot
                  </Badge>
                  <CardTitle className="mt-1">{t}</CardTitle>
                  <CardDescription>{d}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>

          <div className="mt-5 grid grid-cols-2 gap-5 sm:grid-cols-4">
            {['КОТИК В ШАПКЕ', 'ПИТЕРСКАЯ КРЫША', 'ЛОГОТИП', 'САМОВАР'].map((t, i) => (
              <a key={t} href="#" className="lift-card glass relative block overflow-hidden p-0">
                <span className="tick" style={{ top: -1, left: -1 }} />
                <span className="tick" style={{ top: -1, right: -1 }} />
                <span className="tick" style={{ bottom: -1, left: -1 }} />
                <span className="tick" style={{ bottom: -1, right: -1 }} />
                <div
                  className="relative"
                  style={{
                    aspectRatio: '1/1',
                    background: 'var(--color-surface2)',
                    borderBottom: '2.5px solid var(--color-line)',
                  }}
                >
                  <span
                    className="font-display absolute font-black"
                    style={{
                      top: 6,
                      left: 8,
                      fontSize: 13,
                      color: 'var(--color-primary-foreground)',
                      background: 'var(--color-fg)',
                      padding: '0 5px',
                    }}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                  <span className="truncate text-[12px] font-bold tracking-tight">{t}</span>
                  <Badge variant="outline">СЦЕНА</Badge>
                </div>
              </a>
            ))}
          </div>
        </Section>

        <Separator />

        {/* ---- inspector ---- */}
        <Section label="Инспектор · табы, слайдер, переключатель, поле">
          <Card className="max-w-md">
            <CardContent className="pt-5">
              <Tabs defaultValue="color">
                <TabsList className="w-full">
                  <TabsTrigger value="main" className="flex-1">
                    Кадр
                  </TabsTrigger>
                  <TabsTrigger value="color" className="flex-1">
                    Цвет
                  </TabsTrigger>
                  <TabsTrigger value="speed" className="flex-1">
                    Скорость
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="color" className="space-y-5">
                  <div>
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <Label>Яркость</Label>
                      <span className="tnum font-mono">{grade[0]}</span>
                    </div>
                    <Slider value={grade} onValueChange={setGrade} max={100} step={1} />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="hd">1080p HD</Label>
                    <Switch id="hd" checked={hd} onCheckedChange={setHd} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="p">Промпт</Label>
                    <Input id="p" placeholder="что в кадре…" />
                  </div>
                </TabsContent>
                <TabsContent value="main">
                  <p className="text-sm" style={{ color: 'var(--color-muted-foreground)' }}>
                    Параметры кадра.
                  </p>
                </TabsContent>
                <TabsContent value="speed">
                  <p className="text-sm" style={{ color: 'var(--color-muted-foreground)' }}>
                    0.25× – 4×, рампы.
                  </p>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </Section>

        <Separator />

        {/* ---- marquee ---- */}
        <Section label="Маркиза · бегущая строка">
          <div
            className="marquee border-[2.5px] py-1.5 text-[11px] font-bold tracking-[0.18em]"
            style={{
              background: 'var(--color-fg)',
              color: 'var(--color-bg)',
              borderColor: 'var(--color-line)',
            }}
          >
            <span className="marquee-track">
              <span className="px-3">
                ● SEEDANCE 2.0 · 4K · СО ЗВУКОМ · НОВОЕ ●&nbsp;&nbsp;SEEDANCE 2.0 · 4K · СО ЗВУКОМ ·
                НОВОЕ ●&nbsp;&nbsp;
              </span>
              <span className="px-3">
                ● SEEDANCE 2.0 · 4K · СО ЗВУКОМ · НОВОЕ ●&nbsp;&nbsp;SEEDANCE 2.0 · 4K · СО ЗВУКОМ ·
                НОВОЕ ●&nbsp;&nbsp;
              </span>
            </span>
          </div>
        </Section>

        {/* ============================================================
            P1 — PORTED PRIMITIVES (neobrutalism.dev → Slate Brutal via alias).
            The 13 components the app was missing. They speak the neobrutalism
            vocabulary (bg-main / shadow-shadow / rounded-base), which the alias
            block resolves to Slate Brutal — so they render on-brand here with no
            per-component class edits (only the hardcoded white/black focus + alert
            colors were swapped for tokens).
            ============================================================ */}
        <hr className="rule mt-12" />
        <p className="eyebrow-mono mt-8" style={{ color: 'var(--color-accent)' }}>
          P1 · Primitive parity · ported via alias (13)
        </p>

        {/* ---- alert ---- */}
        <Section label="Alert · уведомления">
          <div className="grid max-w-xl gap-3">
            <Alert>
              <Info />
              <AlertTitle>Рендер поставлен в очередь</AlertTitle>
              <AlertDescription>
                Seedance 2.0 · 4K · ~2 мин. Можно закрыть вкладку.
              </AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Не хватает токенов</AlertTitle>
              <AlertDescription>Пополни баланс, чтобы продолжить генерацию.</AlertDescription>
            </Alert>
          </div>
        </Section>

        <Separator />

        {/* ---- textarea · checkbox · radio ---- */}
        <Section label="Форма · textarea · checkbox · radio">
          <div className="grid max-w-2xl gap-6 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="sg-ta">Промпт</Label>
              <Textarea
                id="sg-ta"
                placeholder="Опиши кадр: свет, движение камеры, настроение…"
                defaultValue="Дрон над неоновым городом ночью, дождь, киберпанк."
              />
            </div>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <p className="text-label" style={{ color: 'var(--color-muted-foreground)' }}>
                  Опции
                </p>
                <label className="text-body-sm flex items-center gap-2">
                  <Checkbox defaultChecked /> Со звуком
                </label>
                <label className="text-body-sm flex items-center gap-2">
                  <Checkbox /> Зациклить
                </label>
              </div>
              <div className="grid gap-2">
                <p className="text-label" style={{ color: 'var(--color-muted-foreground)' }}>
                  Формат
                </p>
                <RadioGroup defaultValue="16x9">
                  <label className="text-body-sm flex items-center gap-2">
                    <RadioGroupItem value="16x9" /> 16 : 9
                  </label>
                  <label className="text-body-sm flex items-center gap-2">
                    <RadioGroupItem value="9x16" /> 9 : 16
                  </label>
                  <label className="text-body-sm flex items-center gap-2">
                    <RadioGroupItem value="1x1" /> 1 : 1
                  </label>
                </RadioGroup>
              </div>
            </div>
          </div>
        </Section>

        <Separator />

        {/* ---- progress · skeleton ---- */}
        <Section label="Прогресс · скелетоны">
          <div className="grid max-w-2xl gap-6 sm:grid-cols-2">
            <div className="grid content-start gap-3">
              <Progress value={33} aria-label="Прогресс рендера — 33%" />
              <Progress value={66} aria-label="Прогресс рендера — 66%" />
              <Progress value={100} aria-label="Прогресс рендера — 100%" />
            </div>
            <div className="grid gap-2">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </div>
        </Section>

        <Separator />

        {/* ---- avatar · accordion ---- */}
        <Section label="Аватары · аккордеон">
          <div className="grid max-w-2xl items-start gap-6 sm:grid-cols-2">
            <div className="flex items-center gap-3">
              <Avatar>
                <AvatarFallback>СД</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback>AB</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback>
                  <Film className="size-4" />
                </AvatarFallback>
              </Avatar>
            </div>
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="1">
                <AccordionTrigger>Что такое Seedance?</AccordionTrigger>
                <AccordionContent>
                  Модель ByteDance для генерации видео из текста и изображений.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="2">
                <AccordionTrigger>Сколько длится рендер?</AccordionTrigger>
                <AccordionContent>
                  Обычно 1–3 минуты в зависимости от длины и разрешения.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </Section>

        <Separator />

        {/* ---- table ---- */}
        <Section label="Таблица · очередь рендера">
          <Table>
            <TableCaption>Последние задания</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Модель</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead className="text-right">Кадры</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-mono">0xA1F3</TableCell>
                <TableCell>Seedance 2.0</TableCell>
                <TableCell>
                  <Badge>Готово</Badge>
                </TableCell>
                <TableCell className="tnum text-right">180</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-mono">0xB7C2</TableCell>
                <TableCell>Seedream 3.0</TableCell>
                <TableCell>
                  <Badge variant="outline">В очереди</Badge>
                </TableCell>
                <TableCell className="tnum text-right">96</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-mono">0xC9E1</TableCell>
                <TableCell>Seedance 2.0</TableCell>
                <TableCell>
                  <Badge variant="destructive">Ошибка</Badge>
                </TableCell>
                <TableCell className="tnum text-right">0</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Section>

        <Separator />

        {/* ---- scroll-area · command ---- */}
        <Section label="Scroll area · command palette">
          <div className="grid max-w-2xl gap-6 sm:grid-cols-2">
            <ScrollArea className="border-border h-40 w-full rounded-[var(--radius-md)] border-[2.5px] p-3">
              <div className="text-body-sm grid gap-2">
                {Array.from({ length: 20 }).map((_, i) => (
                  <div key={i}>Пресет #{i + 1} · стиль</div>
                ))}
              </div>
            </ScrollArea>
            <Command className="border-border h-fit border-[2.5px]">
              <CommandInput placeholder="Команда или поиск…" aria-label="Команда или поиск" />
              <CommandList>
                <CommandEmpty>Ничего не найдено.</CommandEmpty>
                <CommandGroup heading="Действия">
                  <CommandItem>
                    <Wand className="size-4" /> Сгенерировать видео
                    <CommandShortcut>⌘G</CommandShortcut>
                  </CommandItem>
                  <CommandItem>
                    <ImageIcon className="size-4" /> Загрузить кадр
                    <CommandShortcut>⌘U</CommandShortcut>
                  </CommandItem>
                </CommandGroup>
                <CommandGroup heading="Навигация">
                  <CommandItem>Галерея</CommandItem>
                  <CommandItem>Доски</CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
        </Section>

        <Separator />

        {/* ---- sheet · sonner ---- */}
        <Section label="Sheet · тосты (sonner)">
          <div className="flex flex-wrap items-center gap-3">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="secondary">Открыть панель</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Настройки рендера</SheetTitle>
                  <SheetDescription>
                    Боковая панель на основе портированного Sheet.
                  </SheetDescription>
                </SheetHeader>
                <div className="grid gap-3 p-4">
                  <Label htmlFor="sg-sheet-ta">Заметки</Label>
                  <Textarea id="sg-sheet-ta" placeholder="Заметки к заданию…" />
                </div>
              </SheetContent>
            </Sheet>
            <Button
              onClick={() =>
                toast.success('Рендер завершён', { description: '0xA1F3 · 180 кадров' })
              }
            >
              <Bell /> Toast success
            </Button>
            <Button
              variant="destructive"
              onClick={() => toast.error('Ошибка рендера', { description: 'Недостаточно токенов' })}
            >
              Toast error
            </Button>
          </div>
        </Section>

        <Separator />

        {/* ---- P5: D3 rendering dynamics (scanline + stepped progress) ---- */}
        <Section label="D3 · динамика рендера · scanline + ступенчатый прогресс">
          <div className="grid max-w-2xl gap-6 sm:grid-cols-2">
            <div className="grid gap-2">
              <p className="text-label" style={{ color: 'var(--color-muted-foreground)' }}>
                Сканлайн · «идёт рендер»
              </p>
              <div className="brutal-scan relative grid h-40 place-items-center rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-bg)] shadow-[5px_5px_0_0_var(--color-shadow)]">
                <span className="seed-pulse-dot h-2.5 w-2.5 rounded-full bg-[color:var(--color-accent)]" />
              </div>
            </div>
            <div className="grid content-center gap-3">
              <p className="text-label" style={{ color: 'var(--color-muted-foreground)' }}>
                Ступенчатый прогресс
              </p>
              <div
                className="seed-step-bar h-2.5 w-full border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)]"
                style={{ ['--pct']: '32%' } as React.CSSProperties}
              />
              <div
                className="seed-step-bar h-2.5 w-full border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)]"
                style={{ ['--pct']: '64%' } as React.CSSProperties}
              />
              <div
                className="seed-step-bar h-2.5 w-full border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)]"
                style={{ ['--pct']: '100%' } as React.CSSProperties}
              />
            </div>
          </div>
        </Section>

        <Toaster />
      </main>
    </TooltipProvider>
  );
}
